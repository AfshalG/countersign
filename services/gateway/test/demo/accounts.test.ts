import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { countersignAccountAbi } from '@countersign/chain';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import {
  createDemoAccount,
  DemoError,
  publicKeyOf,
  setUpDemoAccount,
  type DemoDeps,
} from '../../src/demo/accounts.js';
import { DEMO_FUNDING, demoPlan, setupAction } from '../../src/demo/plan.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { AGENT, CHAIN_ID, CHECKER, demoDeps, FACTORY, type FakeDemoChain } from './fakes.js';

let database: Database;
let store: Store;
let chain: FakeDemoChain;
let sent: { to: Address; data: Hex; gas: bigint }[];
let funded: { to: Address; amount: bigint }[];
let deps: DemoDeps;

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  ({ deps, chain, sent, funded } = demoDeps(store));
});

const judge = SoftPasskey.fromScalar(`0x${'44'.repeat(32)}`);
const key = { qx: judge.qx, qy: judge.qy };
const browser = (passkey: SoftPasskey, digest: Hex) => {
  const a = passkey.sign(digest);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};
const signAll = async (account: Address, passkey = judge) => {
  const row = await store.getDemoAccount(account);
  const plan = demoPlan.fromJson(row?.plan as Parameters<typeof demoPlan.fromJson>[0]);
  return ([0, 1, 2] as const).map((i) =>
    browser(passkey, setupAction(CHAIN_ID, account, plan, i).challenge),
  );
};
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DemoError) return { status: e.status, code: e.code, detail: e.detail };
    throw e;
  }
  throw new Error('expected a refusal');
};
const functionsSent = () =>
  sent
    .filter((t) => t.to !== FACTORY)
    .map((t) => decodeFunctionData({ abi: countersignAccountAbi, data: t.data }).functionName);

describe('judge mode: an account for a new passkey', () => {
  it('creates it, funds it with 0.01 USDC, indexes it, and asks the passkey for three signatures', async () => {
    const view = await createDemoAccount(deps, key);
    expect(sent.map((t) => t.to)).toEqual([FACTORY]);
    expect(funded).toEqual([{ to: view.account, amount: DEMO_FUNDING }]);
    expect((await store.listAccounts()).map((a) => a.address)).toContain(view.account);
    expect(view).toMatchObject({
      status: 'awaiting_passkey',
      waitingPeriodSeconds: 0,
      fundedUsdc: '0.01',
      order: null,
    });
    expect(view.actions.map((a) => a.action)).toEqual(['setPolicy', 'setSupplier', 'approveOrder']);
  });

  it('gives the same passkey the same account, sending nothing twice', async () => {
    const first = await createDemoAccount(deps, key);
    const again = await createDemoAccount(deps, key);
    expect(again.account).toBe(first.account);
    expect(again.actions.map((a) => a.challenge)).toEqual(first.actions.map((a) => a.challenge));
    expect(sent).toHaveLength(1);
    expect(funded).toHaveLength(1);
  });

  it('finishes after a crash without repeating a step (created, not yet funded)', async () => {
    const account = await chain.predictAccount(key.qx, key.qy);
    await store.createDemoAccount({
      account,
      ...key,
      plan: demoPlan.toJson(demoPlan({ agentKey: AGENT, checkerKey: CHECKER, now: 1_791_000_000 })),
    });
    chain.code.add(account.toLowerCase());
    const view = await createDemoAccount(deps, key);
    expect(sent).toHaveLength(0);
    expect(funded).toHaveLength(1);
    expect(view.status).toBe('awaiting_passkey');
  });

  it('takes the key as the browser gives it (SubjectPublicKeyInfo) or as x and y', () => {
    const spki = judge.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    expect(publicKeyOf({ spki })).toEqual(key);
    expect(publicKeyOf({ x: judge.qx, y: judge.qy })).toEqual(key);
    expect(() => publicKeyOf({ x: 'not hex', y: judge.qy })).toThrow(DemoError);
  });

  it('refuses a key that is not on the curve before anything is sent', async () => {
    chain.invalidKey = true;
    expect(await refusal(createDemoAccount(deps, key))).toMatchObject({
      status: 400,
      code: 'invalid_public_key',
    });
    expect(sent).toHaveLength(0);
    expect(await store.getDemoAccount(await chain.predictAccount(key.qx, key.qy))).toBeUndefined();
  });

  it('never reports a transaction that landed as lost: a timed-out wait asks the chain', async () => {
    deps.finality = {
      waitFinal: (hash) => {
        chain.final.set(hash, { status: 'success', blockNumber: 1_002 });
        return Promise.reject(new Error('not final after 60000 ms'));
      },
    };
    expect((await createDemoAccount(deps, key)).status).toBe('awaiting_passkey');
  });

  it('stops at the daily limit (each account costs MON)', async () => {
    deps.perDay = 1;
    await createDemoAccount(deps, key);
    const other = SoftPasskey.fromScalar(`0x${'55'.repeat(32)}`);
    expect(await refusal(createDemoAccount(deps, { qx: other.qx, qy: other.qy }))).toMatchObject({
      status: 429,
      code: 'demo_limit',
    });
  });
});

describe('judge mode: setting the account up with its passkey', () => {
  it('sends the policy, the supplier and the order in nonce order, then shows the order', async () => {
    const { account } = await createDemoAccount(deps, key);
    const view = await setUpDemoAccount(deps, account, await signAll(account));
    expect(functionsSent()).toEqual(['setPolicy', 'setSupplier', 'approveOrder']);
    expect(view).toMatchObject({
      status: 'ready',
      actions: [],
      order: { supplier: 'Kalibre Studio', amountUsdc: '0.005' },
    });
    expect((await store.getDemoAccount(account))?.readyAt).toBeInstanceOf(Date);
  });

  it('refuses an assertion made for another action, before anything reaches the chain', async () => {
    const { account } = await createDemoAccount(deps, key);
    const [a0, a1, a2] = await signAll(account);
    const dryRuns = chain.dryRuns;
    expect(await refusal(setUpDemoAccount(deps, account, [a1, a0, a2]))).toMatchObject({
      status: 422,
      code: 'challenge_mismatch',
      detail: { action: 0 },
    });
    expect(chain.dryRuns).toBe(dryRuns);
    expect(functionsSent()).toEqual([]);
    expect((await store.getDemoAccount(account))?.status).toBe('awaiting_passkey');
  });

  it('refuses a passkey that is not the account’s, at no cost', async () => {
    const { account } = await createDemoAccount(deps, key);
    chain.ownerKeyValid = false;
    const stranger = SoftPasskey.fromScalar(`0x${'66'.repeat(32)}`);
    expect(
      await refusal(setUpDemoAccount(deps, account, await signAll(account, stranger))),
    ).toMatchObject({
      status: 422,
      code: 'invalid_passkey',
    });
    expect(functionsSent()).toEqual([]);
    expect((await store.getDemoAccount(account))?.status).toBe('awaiting_passkey');
  });

  it('resumes from the owner nonce after a crash, sending only what is missing', async () => {
    const { account } = await createDemoAccount(deps, key);
    chain.nonces.set(account.toLowerCase(), 1n); // the policy landed before the crash
    await setUpDemoAccount(deps, account, await signAll(account));
    expect(functionsSent()).toEqual(['setSupplier', 'approveOrder']);
  });

  it('says so for an unknown account, and for one still being created', async () => {
    expect(await refusal(setUpDemoAccount(deps, FACTORY, []))).toMatchObject({ status: 404 });
    const account = await chain.predictAccount(key.qx, key.qy);
    await store.createDemoAccount({
      account,
      ...key,
      plan: demoPlan.toJson(demoPlan({ agentKey: AGENT, checkerKey: CHECKER, now: 1_791_000_000 })),
    });
    expect(await refusal(setUpDemoAccount(deps, account, []))).toMatchObject({
      status: 409,
      code: 'not_created',
    });
  });
});
