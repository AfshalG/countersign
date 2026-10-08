import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createTestAccount, decide, TestOwner } from '@countersign/sdk/test-account';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { TestChecker } from '../../src/checker.js';
import { checkOne } from '../../src/pipeline/check.js';
import { demoPlan } from '../../src/demo/plan.js';
import { hashToken } from '../../src/api/account-tokens.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from '../fakes.js';
import { CHAIN_ID, demoDeps, type FakeDemoChain } from './fakes.js';

/**
 * `@countersign/sdk/test-account` against the gateway (Slice 12 part 2): what a developer runs to
 * get their own account, and how their test owner key decides a hold.
 */
let database: Database;
let store: Store;
let demoChain: FakeDemoChain;
let chain: FakeChain;
let app: ReturnType<typeof createApp>;
const SERVICE = 'test-service-token-0123456789';
const checker = new TestChecker(generatePrivateKey(), CHAIN_ID, () => 'amount_mismatch');

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  const demo = demoDeps(store);
  demoChain = demo.chain;
  chain = new FakeChain();
  app = createApp({
    store,
    chain,
    checker,
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: SERVICE,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
    demo: demo.deps,
  });
});

const viaApp = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;

describe('createTestAccount', () => {
  it('makes a ready account for a new agent key, with a token for it alone', async () => {
    const t = await createTestAccount({
      gateway: 'https://gateway.test/',
      fetch: viaApp,
      waitForOrder: false,
    });
    expect(t.gateway).toBe('https://gateway.test');
    expect(t.agent).toBe(privateKeyToAccount(t.agentKey).address);
    expect(t.order?.supplier).toBe('Kalibre Studio');

    const row = await store.getDemoAccount(t.account);
    expect(row?.status).toBe('ready');
    const plan = demoPlan.fromJson(row?.plan as Parameters<typeof demoPlan.fromJson>[0]);
    expect(plan.policy.agentKey).toBe(t.agent);
    // The owner key is the account's owner passkey.
    const owner = TestOwner.fromPrivateKey(t.ownerKey);
    expect(demoChain.ownerKeys.get(t.account.toLowerCase())).toEqual({ qx: owner.x, qy: owner.y });
    expect(await store.apiTokenAccount(hashToken(t.token))).toBe(t.account.toLowerCase());
  });

  it('reports the gateway’s refusal by its code', async () => {
    demoChain.invalidKey = true;
    await expect(
      createTestAccount({ gateway: 'https://gateway.test', fetch: viaApp, waitForOrder: false }),
    ).rejects.toMatchObject({ code: 'invalid_public_key', status: 400 });
  });
});

describe('decide', () => {
  it('refuses a hold with the test owner key, and says what is not offered', async () => {
    const owner = TestOwner.random();
    chain.ownerKeys = [{ qx: owner.x, qy: owner.y }];
    chain.onFile = SUPPLIER;
    const res = await app.request('/v1/payments', {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        account: ACCOUNT,
        vault: VAULT,
        payment: {
          amount: '1000',
          invoiceHash: keccak256(toHex('INV-decide')),
          payTo: SUPPLIER,
          deadline: 1_791_400_000,
        },
        agentSig: AGENT_SIG,
      }),
    });
    const { request } = (await res.json()) as { request: { id: Hex } };
    const row = await store.get(request.id);
    if (!row) throw new Error('no row');
    await checkOne({ store, chain, checker, chainId: CHAIN_ID, checkerTimeoutMs: 2_000 }, row);
    expect((await store.get(request.id))?.status).toBe('held');

    const refused = await decide({
      id: request.id,
      action: 'refuse',
      ownerKey: owner.privateKey,
      gateway: 'https://gateway.test',
      fetch: viaApp,
    });
    expect(refused.status).toBe('refused');
    await expect(
      decide({
        id: request.id,
        action: 'pay_once',
        ownerKey: owner.privateKey,
        gateway: 'https://gateway.test',
        fetch: viaApp,
      }),
    ).rejects.toMatchObject({ code: 'not_offered' });
  });
});
