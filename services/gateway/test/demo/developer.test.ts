import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { TestChecker } from '../../src/checker.js';
import type { DemoDeps } from '../../src/demo/accounts.js';
import { demoPlan } from '../../src/demo/plan.js';
import { hashToken, tokenChallenge } from '../../src/api/account-tokens.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { FakeChain } from '../fakes.js';
import { AGENT, CHAIN_ID, demoDeps } from './fakes.js';

/**
 * A developer's own test account (Slice 12 part 2): judge mode with the developer's agent key in
 * the policy, and a token for that account only, issued to its owner's passkey.
 */
let database: Database;
let store: Store;
let deps: DemoDeps;
const SERVICE = 'test-service-token-0123456789';
const MY_AGENT: Address = '0x4444444444444444444444444444444444444444';

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  ({ deps } = demoDeps(store));
});

const app = () =>
  createApp({
    store,
    chain: new FakeChain(),
    checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: SERVICE,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
    demo: {
      ...deps,
      agent: { pay: () => Promise.reject(new Error('the demo agent must not pay')) },
    },
  });

const owner = SoftPasskey.fromScalar(`0x${'55'.repeat(32)}`);
const stranger = SoftPasskey.fromScalar(`0x${'66'.repeat(32)}`);
const assertion = (key: SoftPasskey, digest: Hex) => {
  const a = key.sign(digest);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};
type View = {
  account: Address;
  status: string;
  agent: { address: Address; hosted: boolean };
  actions: { action: string; summary: string; challenge: Hex }[];
};
const post = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const create = async (a: ReturnType<typeof app>, agent?: Address) =>
  (await (
    await post(a, '/v1/demo/accounts', {
      publicKey: { x: owner.qx, y: owner.qy },
      ...(agent === undefined ? {} : { agent }),
    })
  ).json()) as View;

describe('a test account with the developer’s own agent', () => {
  it('names their agent in the policy, as a separate account from the judge’s', async () => {
    const a = app();
    const judge = await create(a);
    const mine = await create(a, MY_AGENT);
    expect(mine.account).not.toBe(judge.account);
    expect(mine.agent).toEqual({ address: MY_AGENT, hosted: false });
    expect(judge.agent).toEqual({ address: AGENT, hosted: true });
    expect(mine.actions[0]?.summary).toContain(`Let your agent ${MY_AGENT} pay`);
    const row = await store.getDemoAccount(mine.account);
    const plan = demoPlan.fromJson(row?.plan as Parameters<typeof demoPlan.fromJson>[0]);
    expect(plan.policy.agentKey).toBe(MY_AGENT);
    // The same passkey and agent find the same account.
    expect((await create(a, MY_AGENT)).account).toBe(mine.account);
  });

  it('naming the hosted demo agent is the judge account', async () => {
    const a = app();
    expect((await create(a, AGENT)).account).toBe((await create(a)).account);
  });

  it('is set up with three passkey signatures, and the demo agent never pays into it', async () => {
    const a = app();
    const mine = await create(a, MY_AGENT);
    const setUp = await post(a, `/v1/demo/accounts/${mine.account}/setup`, {
      assertions: mine.actions.map((x) => assertion(owner, x.challenge)),
    });
    expect(((await setUp.json()) as View).status).toBe('ready');
    const invoice = await post(a, `/v1/demo/accounts/${mine.account}/invoices`, { kind: 'clean' });
    expect(invoice.status).toBe(409);
    expect(((await invoice.json()) as { error: string }).error).toBe('not_hosted');
  });
});

describe('getting an account token with the owner’s passkey', () => {
  type Ask = { account: Address; generation: number; challenge: Hex; summary: string };
  const ask = async (a: ReturnType<typeof app>, account: Address) =>
    (await (await a.request(`/v1/demo/accounts/${account}/token`)).json()) as Ask;
  const take = (a: ReturnType<typeof app>, account: Address, key: SoftPasskey, challenge: Hex) =>
    post(a, `/v1/demo/accounts/${account}/token`, { assertion: assertion(key, challenge) });

  it('gives a token for that account only, once per signature; a new one replaces the old', async () => {
    const a = app();
    const { account } = await create(a, MY_AGENT);
    const first = await ask(a, account);
    expect(first.generation).toBe(0);
    expect(first.challenge).toBe(tokenChallenge(CHAIN_ID, account, 0));

    const res = await take(a, account, owner, first.challenge);
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(token).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);
    expect(await store.apiTokenAccount(hashToken(token))).toBe(account.toLowerCase());
    const orders = await a.request(`/v1/accounts/${account}/orders`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(orders.status).toBe(200);

    // The same signature again: the challenge has moved on.
    const replay = await take(a, account, owner, first.challenge);
    expect(replay.status).toBe(422);
    expect(((await replay.json()) as { error: string }).error).toBe('challenge_mismatch');

    const second = await ask(a, account);
    expect(second.generation).toBe(1);
    const res2 = await take(a, account, owner, second.challenge);
    const { token: newer } = (await res2.json()) as { token: string };
    expect(await store.apiTokenAccount(hashToken(token))).toBeNull();
    expect(await store.apiTokenAccount(hashToken(newer))).toBe(account.toLowerCase());
  });

  it('refuses a passkey that is not the owner’s', async () => {
    const a = app();
    const { account } = await create(a, MY_AGENT);
    const res = await take(a, account, stranger, (await ask(a, account)).challenge);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_passkey');
    expect(await store.nextTokenGeneration(account)).toBe(0);
  });

  it('knows only demo accounts', async () => {
    const a = app();
    const unknown = '0x5555555555555555555555555555555555555555';
    expect((await a.request(`/v1/demo/accounts/${unknown}/token`)).status).toBe(404);
  });
});
