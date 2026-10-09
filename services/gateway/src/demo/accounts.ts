import { encodeFunctionData, getAddress, zeroHash, type Address, type Hex } from 'viem';
import { accountFactoryAbi, GAS_LIMITS } from '@countersign/chain';
import { formatUsdc } from '@countersign/shared';
import type { DemoAccountRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import type { RelayerPool } from '../relay/pool.js';
import type { FinalityTracker } from '../chain/finality.js';
import type { DemoAgent } from './invoices.js';
import { finalOf, OwnerActionError, sendAndWait } from '../owner/send.js';
import { AssertionError, fromBrowser, type BrowserAssertion } from '../api/webauthn.js';
import { hashToken, newAccountToken, tokenChallenge } from '../api/account-tokens.js';
import { ownerSigOf } from '../owner/signers.js';
import type { OwnerKey } from '../chain/types.js';
import {
  DEMO_FUNDING,
  DEMO_WAITING_PERIOD,
  demoPlan,
  demoSalt,
  SETUP_ACTIONS,
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
  /** A transaction's receipt once it is in a finalized block; null if it is not (yet). */
  finalizedReceipt(
    hash: Hex,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null>;
  /** The account's owner passkeys (an account token is issued to any one of them). */
  ownership(account: Address): Promise<{ owners: OwnerKey[] }>;
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
  /** The demo agent's key (testnet only), for the demo invoices it pays into judges' accounts. */
  agentPrivateKey?: Hex;
  /** For tests: the demo agent itself. */
  agent?: DemoAgent;
  /**
   * Slice 15: the latest proof that Kalibre Studio's own website lists its address (zero if none
   * is fresh), so a new account's supplier record names its evidence.
   */
  kalibreProof?: () => Promise<Hex>;
  finalTimeoutMs?: number;
};

/** Judge mode's refusals are owner-action refusals: one error type for every passkey route. */
export const DemoError = OwnerActionError;
export type DemoError = OwnerActionError;

const SETUP_GAS: Record<SetupIndex, bigint> = {
  0: GAS_LIMITS.setPolicy,
  1: GAS_LIMITS.setSupplier,
  2: GAS_LIMITS.approveOrder,
};
const INDEXES: readonly SetupIndex[] = [0, 1, 2];

/** Moved to src/owner/keys.ts for D36 (adding an owner takes the same key format). */
export { publicKeyOf } from '../owner/keys.js';

/** What the app shows for a demo account. */
export function demoView(row: DemoAccountRow, chainId: number) {
  const plan = demoPlan.fromJson(row.plan as Parameters<typeof demoPlan.fromJson>[0]);
  const account = row.account as Address;
  return {
    account,
    status: row.status,
    agent: { address: plan.policy.agentKey, hosted: !plan.ownAgent },
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

/**
 * Creates (or finds) the demo account for a passkey: the factory creates it through a relayer,
 * the funding wallet sends it 0.01 test USDC, and the order indexer starts following it. Every
 * step checks the chain first, so calling again after a crash finishes the job without repeating
 * a step. The same passkey always gets the same account (the factory's deterministic address).
 */
export function createDemoAccount(deps: DemoDeps, key: { qx: Hex; qy: Hex }, agent?: Address) {
  // Naming the hosted demo agent is the judge account; any other agent is a developer's own.
  const ownAgent =
    agent === undefined || agent.toLowerCase() === deps.agentKey.toLowerCase()
      ? undefined
      : getAddress(agent);
  const salt = demoSalt(ownAgent);
  return serially(`${key.qx}:${key.qy}:${salt}`, async () => {
    const account = await deps.chain.predictAccount(key.qx, key.qy, DEMO_WAITING_PERIOD, salt);
    const row = await deps.store.getDemoAccount(account);
    if (row && row.status !== 'creating') return demoView(row, deps.chainId);

    const create = encodeFunctionData({
      abi: accountFactoryAbi,
      functionName: 'createAccount',
      args: [key.qx, key.qy, DEMO_WAITING_PERIOD, salt],
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
        agentKey: ownAgent ?? deps.agentKey,
        checkerKey: deps.checkerKey,
        now: Math.floor(Date.now() / 1000),
        ownAgent: ownAgent !== undefined,
        supplierProof: (await deps.kalibreProof?.().catch(() => undefined)) ?? zeroHash,
      });
      await deps.store.createDemoAccount({
        account,
        qx: key.qx,
        qy: key.qy,
        plan: demoPlan.toJson(plan),
      });
    }

    // The account and its test USDC at once (9 Oct; one after the other took 4.6 s on a phone):
    // the address is the factory's deterministic one, so the USDC can land before the code. Both
    // finish, whatever happens to the other, before an error is answered, so a retry never finds a
    // transfer still in flight and sends a second.
    const [hasCode, balance] = await Promise.all([
      deps.chain.hasCode(account),
      deps.chain.usdcBalance(account),
    ]);
    const steps = await Promise.allSettled([
      hasCode
        ? Promise.resolve()
        : sendAndWait(
            deps,
            deps.factory,
            create,
            GAS_LIMITS.createAccount,
            `demo ${account} createAccount`,
          ),
      balance >= DEMO_FUNDING
        ? Promise.resolve()
        : deps.funder.sendUsdc(account, DEMO_FUNDING - balance).then((hash) => {
            const waiting = deps.finality.waitFinal(hash, deps.finalTimeoutMs ?? 60_000);
            return finalOf(deps, hash, waiting, 'the USDC transfer');
          }),
    ]);
    const failed = steps.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
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
        // A new demo account has one owner (D36: thresholds of one until it adds more).
        const data = setupCall(plan, index, [
          { owner: 0, auth: auths[index] as (typeof auths)[number] },
        ]);
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
        await sendAndWait(
          deps,
          account,
          data,
          SETUP_GAS[index],
          `demo ${account} ${SETUP_ACTIONS[index]}`,
        );
      }
    } catch (e) {
      await deps.store.setDemoStatus(account, 'awaiting_passkey');
      throw e;
    }
    const view = demoView(await deps.store.setDemoStatus(account, 'ready'), deps.chainId);
    // The phone's token in the same answer (9 Oct): the setup signatures already prove this
    // passkey is the account's owner, so a fifth Face ID only for a token asked nothing new. Checked
    // off chain against the owner keys, as a token's own signature is, and only in the call that
    // set the account up: replayed assertions find it ready above and get no token.
    if (!(await ownerSigOf(deps.chain, account, auths[2] as (typeof auths)[number], true)))
      return view;
    const generation = await deps.store.nextTokenGeneration(account);
    const token = newAccountToken();
    if (!(await deps.store.issueApiToken(account, hashToken(token), generation))) return view;
    return { ...view, token };
  });
}

/** What an owner signs for the account's next token (Slice 12 part 2). */
export async function tokenAsk(deps: Pick<DemoDeps, 'store' | 'chainId'>, account: Address) {
  const row = await deps.store.getDemoAccount(account);
  if (!row) throw new DemoError(404, 'unknown_account', 'no demo account at this address');
  const generation = await deps.store.nextTokenGeneration(account);
  return {
    account: row.account as Address,
    generation,
    challenge: tokenChallenge(deps.chainId, row.account as Address, generation),
    summary: 'Get an API token for this account (it replaces any earlier one)',
  };
}

/**
 * An account token for the owner who signed: checked off chain against the account's owner keys
 * (nothing on chain checks it later), stored only as its hash, and shown once.
 */
export async function issueAccountToken(
  deps: Pick<DemoDeps, 'store' | 'chain' | 'chainId'>,
  account: Address,
  assertion: unknown,
) {
  const ask = await tokenAsk(deps, account);
  const row = await deps.store.getDemoAccount(account);
  if (row?.status === 'creating')
    throw new DemoError(409, 'not_created', 'the account is still being created');
  let auth;
  try {
    auth = fromBrowser(assertion as BrowserAssertion, ask.challenge);
  } catch (e) {
    if (!(e instanceof AssertionError)) throw e;
    throw new DemoError(e.code === 'challenge_mismatch' ? 422 : 400, e.code, e.message);
  }
  if (!(await ownerSigOf(deps.chain, ask.account, auth, true)))
    throw new DemoError(422, 'invalid_passkey', 'not this account’s passkey');
  const token = newAccountToken();
  if (!(await deps.store.issueApiToken(ask.account, hashToken(token), ask.generation)))
    throw new DemoError(409, 'token_used', 'that signature already made a token; sign again');
  return {
    account: ask.account,
    token,
    generation: ask.generation,
    note: 'Shown once. It reaches only this account; getting a new one revokes it.',
  };
}
