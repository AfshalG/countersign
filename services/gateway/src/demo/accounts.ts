import { encodeFunctionData, type Address, type Hex } from 'viem';
import { accountFactoryAbi, GAS_LIMITS } from '@countersign/chain';
import { formatUsdc } from '@countersign/shared';
import type { DemoAccountRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import type { RelayerPool } from '../relay/pool.js';
import type { FinalityTracker } from '../chain/finality.js';
import { AssertionError, fromBrowser, type BrowserAssertion } from '../api/webauthn.js';
import {
  DEMO_FUNDING,
  DEMO_SALT,
  DEMO_WAITING_PERIOD,
  demoPlan,
  setupAction,
  setupCall,
  type DemoPlan,
  type SetupIndex,
} from './plan.js';

/** What judge mode reads from Monad. The real one is src/chain/monad.ts; tests use a fake. */
export interface DemoChain {
  predictAccount(qx: Hex, qy: Hex, waitingPeriod: bigint, salt: Hex): Promise<Address>;
  hasCode(address: Address): Promise<boolean>;
  ownerNonce(account: Address): Promise<bigint>;
  usdcBalance(address: Address): Promise<bigint>;
  latestFinalized(): Promise<number>;
  /** The call as an eth_call: undefined if it would succeed, otherwise the contract's error name. */
  dryRun(to: Address, data: Hex): Promise<string | undefined>;
}

/** Sends test USDC from the demo funding wallet (not a relayer: relayers never hold money). */
export interface Funder {
  sendUsdc(to: Address, amount: bigint): Promise<Hex>;
}

export type DemoDeps = {
  store: Store;
  chain: DemoChain;
  pool: Pick<RelayerPool, 'sign' | 'enqueue'>;
  finality: Pick<FinalityTracker, 'waitFinal'>;
  funder: Funder;
  chainId: number;
  factory: Address;
  /** The hosted demo agent (testnet only) and the gateway's checker, named in every demo policy. */
  agentKey: Address;
  checkerKey: Address;
  /** New demo accounts allowed per UTC day: each costs about 0.09 MON to set up. */
  perDay: number;
  finalTimeoutMs?: number;
};

export class DemoError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 429,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const SETUP_GAS: Record<SetupIndex, bigint> = {
  0: GAS_LIMITS.setPolicy,
  1: GAS_LIMITS.setSupplier,
  2: GAS_LIMITS.approveOrder,
};
const INDEXES: readonly SetupIndex[] = [0, 1, 2];

/**
 * The new passkey's public key: `{ x, y }` as hex (what `ox` gives), or the SubjectPublicKeyInfo
 * the browser's `response.getPublicKey()` returns (base64url; for P-256 its last 65 bytes are
 * 0x04 ‖ x ‖ y). Whether the point is on the curve is the contract's check (InvalidOwnerKey).
 */
export function publicKeyOf(input: { x?: string; y?: string; spki?: string }): {
  qx: Hex;
  qy: Hex;
} {
  const word = (v: string | undefined, name: string): Hex => {
    if (v === undefined || !/^0x[0-9a-fA-F]{1,64}$/.test(v))
      throw new DemoError(400, 'invalid_public_key', `${name} must be 32-byte hex`);
    return `0x${v.slice(2).padStart(64, '0')}`;
  };
  if (input.spki !== undefined) {
    const bytes = Buffer.from(input.spki, 'base64url');
    if (bytes.length < 65 || bytes[bytes.length - 65] !== 0x04)
      throw new DemoError(400, 'invalid_public_key', 'not an uncompressed P-256 public key');
    const point = bytes.subarray(bytes.length - 64);
    return {
      qx: `0x${point.subarray(0, 32).toString('hex')}`,
      qy: `0x${point.subarray(32).toString('hex')}`,
    };
  }
  return { qx: word(input.x, 'x'), qy: word(input.y, 'y') };
}

/** What the app shows for a demo account. */
export function demoView(row: DemoAccountRow, chainId: number) {
  const plan = demoPlan.fromJson(row.plan as Parameters<typeof demoPlan.fromJson>[0]);
  const account = row.account as Address;
  return {
    account,
    status: row.status,
    waitingPeriodSeconds: Number(DEMO_WAITING_PERIOD),
    fundedUsdc: formatUsdc(DEMO_FUNDING),
    signBy: new Date(Number(plan.deadline) * 1000).toISOString(),
    actions:
      row.status === 'ready' ? [] : INDEXES.map((i) => setupAction(chainId, account, plan, i)),
    order:
      row.status === 'ready'
        ? {
            orderId: plan.order.orderId,
            supplier: 'Kalibre Studio',
            payTo: plan.supplier.payTo,
            amountUsdc: formatUsdc(plan.order.amount),
          }
        : null,
  };
}

const startOfUtcDay = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/** One flow per account at a time in this process (one gateway runs per relayer set). */
const running = new Map<string, Promise<unknown>>();
function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = running.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  running.set(key, next);
  // Cleanup on both outcomes; the caller handles the rejection (a refusal), not this chain.
  const cleanup = () => {
    if (running.get(key) === next) running.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function sendAndWait(deps: DemoDeps, to: Address, data: Hex, gas: bigint, what: string) {
  const signed = await deps.pool.sign({ to, data, gas });
  deps.pool.enqueue(signed);
  const receipt = await deps.finality.waitFinal(signed.hash, deps.finalTimeoutMs ?? 60_000);
  if (receipt.status !== 'success')
    throw new DemoError(409, 'reverted', `${what} reverted on chain`, { tx: signed.hash });
  return signed.hash;
}

/**
 * Creates (or finds) the demo account for a passkey: the factory creates it through a relayer,
 * the funding wallet sends it 0.01 test USDC, and the order indexer starts following it. Every
 * step checks the chain first, so calling again after a crash finishes the job without repeating
 * a step. The same passkey always gets the same account (the factory's deterministic address).
 */
export function createDemoAccount(deps: DemoDeps, key: { qx: Hex; qy: Hex }) {
  return serially(`${key.qx}:${key.qy}`, async () => {
    const account = await deps.chain.predictAccount(key.qx, key.qy, DEMO_WAITING_PERIOD, DEMO_SALT);
    const row = await deps.store.getDemoAccount(account);
    if (row && row.status !== 'creating') return demoView(row, deps.chainId);

    const create = encodeFunctionData({
      abi: accountFactoryAbi,
      functionName: 'createAccount',
      args: [key.qx, key.qy, DEMO_WAITING_PERIOD, DEMO_SALT],
    });
    if (!row) {
      if ((await deps.store.demoAccountsSince(startOfUtcDay())) >= deps.perDay)
        throw new DemoError(429, 'demo_limit', 'today’s demo accounts are used up; try tomorrow');
      const refusal = await deps.chain.dryRun(deps.factory, create);
      if (refusal === 'InvalidOwnerKey')
        throw new DemoError(400, 'invalid_public_key', 'not a valid P-256 public key');
      if (refusal !== undefined)
        throw new DemoError(409, 'contract_refuses', 'the factory refuses this account', {
          contract: refusal,
        });
      const plan: DemoPlan = demoPlan({
        agentKey: deps.agentKey,
        checkerKey: deps.checkerKey,
        now: Math.floor(Date.now() / 1000),
      });
      await deps.store.createDemoAccount({
        account,
        qx: key.qx,
        qy: key.qy,
        plan: demoPlan.toJson(plan),
      });
    }

    if (!(await deps.chain.hasCode(account)))
      await sendAndWait(deps, deps.factory, create, GAS_LIMITS.createAccount, 'createAccount');
    const balance = await deps.chain.usdcBalance(account);
    if (balance < DEMO_FUNDING) {
      const hash = await deps.funder.sendUsdc(account, DEMO_FUNDING - balance);
      const receipt = await deps.finality.waitFinal(hash, deps.finalTimeoutMs ?? 60_000);
      if (receipt.status !== 'success')
        throw new DemoError(409, 'reverted', 'the USDC transfer reverted', { tx: hash });
    }
    await deps.store.registerAccount(account, await deps.chain.latestFinalized(), 'demo');
    const ready = await deps.store.setDemoStatus(account, 'awaiting_passkey');
    return demoView(ready, deps.chainId);
  });
}

/**
 * Sets the account up with the three assertions its passkey made, in nonce order: each is checked
 * against its own challenge before anything is sent, each call is dry-run first (a passkey that is
 * not the owner's costs nothing), and each is final before the next. Starts from the account's
 * owner nonce, so a call after a crash sends only what is missing.
 */
export function setUpDemoAccount(deps: DemoDeps, account: Address, assertions: unknown[]) {
  return serially(account.toLowerCase(), async () => {
    const row = await deps.store.getDemoAccount(account);
    if (!row) throw new DemoError(404, 'unknown_account', 'no demo account at this address');
    if (row.status === 'ready') return demoView(row, deps.chainId);
    if (row.status === 'creating')
      throw new DemoError(409, 'not_created', 'the account is still being created');
    if (assertions.length !== 3)
      throw new DemoError(400, 'malformed_assertion', 'three assertions, one per setup action');

    const plan = demoPlan.fromJson(row.plan as Parameters<typeof demoPlan.fromJson>[0]);
    const auths = INDEXES.map((i) => {
      const challenge = setupAction(deps.chainId, account, plan, i).challenge;
      try {
        return fromBrowser(assertions[i] as BrowserAssertion, challenge);
      } catch (e) {
        if (!(e instanceof AssertionError)) throw e;
        throw new DemoError(
          e.code === 'challenge_mismatch' ? 422 : 400,
          e.code,
          `setup action ${String(i)}: ${e.message}`,
          { action: i },
        );
      }
    });

    await deps.store.setDemoStatus(account, 'setting_up');
    try {
      for (let i = Number(await deps.chain.ownerNonce(account)); i < 3; i++) {
        const index = i as SetupIndex;
        const data = setupCall(plan, index, auths[index] as (typeof auths)[number]);
        const refusal = await deps.chain.dryRun(account, data);
        if (refusal === 'InvalidOwnerSignature')
          throw new DemoError(422, 'invalid_passkey', 'not this account’s passkey', {
            action: index,
          });
        if (refusal !== undefined)
          throw new DemoError(409, 'contract_refuses', `setup action ${String(index)} refused`, {
            action: index,
            contract: refusal,
          });
        await sendAndWait(deps, account, data, SETUP_GAS[index], `setup action ${String(index)}`);
      }
    } catch (e) {
      await deps.store.setDemoStatus(account, 'awaiting_passkey');
      throw e;
    }
    return demoView(await deps.store.setDemoStatus(account, 'ready'), deps.chainId);
  });
}
