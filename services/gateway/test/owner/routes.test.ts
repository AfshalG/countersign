import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { TestChecker } from '../../src/checker.js';
import { proposalId } from '../../src/api/orders.js';
import type { ProposalDeps } from '../../src/owner/proposals.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { FakeChain } from '../fakes.js';
import { CHAIN_ID, demoDeps, type FakeDemoChain } from '../demo/fakes.js';

let database: Database;
let store: Store;
let chain: FakeDemoChain;
let proposals: ProposalDeps;
const ACCOUNT: Address = '0x4444444444444444444444444444444444444444';
const owner = SoftPasskey.fromScalar(`0x${'99'.repeat(32)}`);

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  const fake = demoDeps(store);
  chain = fake.chain;
  proposals = { ...fake.deps, store, chain, publicUrl: 'https://gateway.test' };
  chain.ownerKeys.set(ACCOUNT.toLowerCase(), { qx: owner.qx, qy: owner.qy });
  chain.usdc.set(ACCOUNT.toLowerCase(), 50_000n);
});

const appWith = (p: ProposalDeps | undefined) =>
  createApp({
    store,
    chain: new FakeChain(),
    checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: 'test-service-token-0123456789',
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
    ...(p ? { proposals: p } : {}),
  });
async function proposed() {
  const documentHash = keccak256(toHex('quote Q-77 from Northwind Prints'));
  const { proposal } = await store.createProposal({
    id: proposalId(ACCOUNT, documentHash),
    account: ACCOUNT,
    supplierName: 'Northwind Prints',
    website: null,
    payTo: '0x5555555555555555555555555555555555555555',
    amount: '20000',
    expiry: Math.floor(Date.now() / 1000) + 30 * 86_400,
    documentHash,
    document: null,
  });
  return proposal.id;
}
type View = { status: string; actions: Record<string, { challenge: Hex; summary?: string }> };
const browser = (digest: Hex) => {
  const a = owner.sign(digest);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};
const post = (app: ReturnType<typeof appWith>, id: string, body: unknown) =>
  app.request(`/v1/approvals/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('proposals over the approvals routes (no token: the passkey decides)', () => {
  it('shows what to sign, then approves with both assertions', async () => {
    const app = appWith(proposals);
    const id = await proposed();
    const view = (await (await app.request(`/v1/approvals/${id}`)).json()) as View;
    expect(Object.keys(view.actions).sort()).toEqual(['approve_order', 'refuse', 'set_supplier']);
    expect(view.actions.set_supplier?.summary).toContain('Northwind Prints');
    const res = await post(app, id, {
      action: 'approve',
      assertions: {
        set_supplier: browser(view.actions.set_supplier?.challenge as Hex),
        approve_order: browser(view.actions.approve_order?.challenge as Hex),
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as View).status).toBe('approved');
  });

  it('refuses with one assertion', async () => {
    const app = appWith(proposals);
    const id = await proposed();
    const view = (await (await app.request(`/v1/approvals/${id}`)).json()) as View;
    const res = await post(app, id, {
      action: 'refuse',
      assertion: browser(view.actions.refuse?.challenge as Hex),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as View).status).toBe('refused');
  });

  it('answers a wrong action or a missing assertion plainly', async () => {
    const app = appWith(proposals);
    const id = await proposed();
    expect(
      (await post(app, id, { action: 'pay_once', assertion: browser(`0x${'00'.repeat(32)}`) }))
        .status,
    ).toBe(422);
    expect((await post(app, id, { action: 'refuse' })).status).toBe(400);
    expect((await post(app, id, { action: 'approve', assertions: {} })).status).toBe(400);
  });

  it('without the chain behind it, shows the proposal with nothing to sign', async () => {
    const id = await proposed();
    const view = (await (await appWith(undefined).request(`/v1/approvals/${id}`)).json()) as View;
    expect(view.status).toBe('pending');
    expect(view.actions).toEqual({});
  });
});
