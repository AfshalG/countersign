import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { supplierId } from '@countersign/shared';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

let database: Database;
let store: Store;
let chain: FakeChain;
let app: ReturnType<typeof createApp>;
let catchUps = 0;
const TOKEN = 'test-service-token-0123456789';
const PUBLIC = 'https://gateway.example';
const NOW = Math.floor(Date.now() / 1000);
const VAULT_2: Address = '0x771d1b283D9Bf9A6e14bAdF0c9C4d1BE05D87dC7';
const SUPPLIER_ID = keccak256(toHex('kalibre-studio'));

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  chain = new FakeChain();
  catchUps = 0;
  app = createApp({
    store,
    chain,
    checker: new TestChecker(generatePrivateKey(), 10143),
    chainId: 10143,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: PUBLIC,
    indexing: {
      latestFinalized: () => Promise.resolve(5_000),
      catchUp: () => {
        catchUps++;
        return Promise.resolve();
      },
    },
    health: () => Promise.resolve({}),
  });
});

const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
const get = (path: string) => app.request(path, { headers });

async function seedOrder(
  vault: Address,
  order: string,
  opts: { closed?: boolean; expiry?: number } = {},
) {
  await store.upsertOrder({
    vault,
    account: ACCOUNT,
    orderId: keccak256(toHex(order)),
    supplierId: SUPPLIER_ID,
    orderHash: keccak256(toHex(`${order} PDF`)),
    amount: '30000',
    expiry: opts.expiry ?? NOW + 86_400,
    approvedBlock: 4_000,
  });
  if (opts.closed === true) await store.closeOrder(vault);
}

describe('accounts and their open orders', () => {
  it('registers an account to index (from a block, or from now), once', async () => {
    const first = await post('/v1/accounts', { account: ACCOUNT, fromBlock: 3_000 });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ account: ACCOUNT, indexedTo: 2_999 });
    expect(catchUps).toBe(1);
    const again = await post('/v1/accounts', { account: ACCOUNT });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ indexedTo: 2_999 });
    const other = await post('/v1/accounts', { account: SUPPLIER });
    // From the latest finalized block, that block included: no gap.
    expect(await other.json()).toMatchObject({ indexedTo: 4_999 });
  });

  it('lists open orders with what is left and the address on file, read live', async () => {
    await store.registerAccount(ACCOUNT, 3_000);
    await seedOrder(VAULT, 'order 1');
    await seedOrder(VAULT_2, 'order 2');
    await seedOrder('0x2222222222222222222222222222222222222222', 'closed', { closed: true });
    await seedOrder('0x3333333333333333333333333333333333333333', 'expired', { expiry: NOW - 10 });
    chain.remaining.set(VAULT.toLowerCase(), 13_600n);
    const res = await get(`/v1/accounts/${ACCOUNT}/orders`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Record<string, unknown>[]; indexedTo: number };
    expect(body.indexedTo).toBe(2_999);
    expect(body.orders).toHaveLength(2);
    expect(body.orders[0]).toMatchObject({
      vault: VAULT,
      orderId: keccak256(toHex('order 1')),
      supplierId: SUPPLIER_ID,
      payTo: SUPPLIER,
      amount: '30000',
      remaining: '13600',
      supplierActive: true,
      // The supplier by name (Slice 11's suppliers screen).
      supplierName: 'Kalibre Studio',
    });
  });

  it('says so for an account it does not know, and answers 503 when the chain cannot be read', async () => {
    expect((await get(`/v1/accounts/${ACCOUNT}/orders`)).status).toBe(404);
    await store.registerAccount(ACCOUNT, 3_000);
    await seedOrder(VAULT, 'order 1');
    chain.onFile = undefined;
    const res = await get(`/v1/accounts/${ACCOUNT}/orders`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'chain_unavailable' });
  });
});

describe('proposals', () => {
  const proposal = (name = 'Kalibre Studio') => ({
    account: ACCOUNT,
    supplier: { name, website: 'https://kalibre.example', payTo: SUPPLIER },
    order: { amount: '4200000000', expiry: NOW + 30 * 86_400 },
    documentHash: keccak256(toHex('quote Q-2026-001')),
  });

  it('records a proposal with an approval link, once per document, and changes nothing on chain', async () => {
    const simulations = chain.simulations;
    const res = await post('/v1/proposals', proposal());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean; proposal: Record<string, unknown> };
    expect(body.created).toBe(true);
    expect(body.proposal).toMatchObject({
      status: 'pending',
      supplierName: 'Kalibre Studio',
      amount: '4200000000',
    });
    expect(body.proposal.approvalUrl).toBe(`${PUBLIC}/p/${String(body.proposal.id)}`);
    const again = await post('/v1/proposals', proposal());
    expect(again.status).toBe(200);
    expect(((await again.json()) as { proposal: { id: string } }).proposal.id).toBe(
      body.proposal.id,
    );
    expect((await get(`/v1/proposals/${String(body.proposal.id)}`)).status).toBe(200);
    expect((await get(`/v1/proposals/0x${'00'.repeat(32)}`)).status).toBe(404);
    expect(chain.simulations).toBe(simulations);
  });

  it('refuses a website that is not https and an address that is not one', async () => {
    const bad = {
      ...proposal(),
      supplier: { name: 'X', website: 'http://kalibre.example', payTo: '0x1234' },
    };
    const res = await post('/v1/proposals', bad);
    expect(res.status).toBe(400);
    const issues = ((await res.json()) as { issues: { path: string }[] }).issues.map((i) => i.path);
    expect(issues).toEqual(expect.arrayContaining(['supplier.website', 'supplier.payTo']));
  });
});

describe('the status page', () => {
  it('shows a held look-alike in plain words, with both addresses, without a token', async () => {
    await store.upsertOrder({
      vault: VAULT,
      account: ACCOUNT,
      orderId: keccak256(toHex('order for the page')),
      supplierId: supplierId('kalibre-studio'),
      orderHash: keccak256(toHex('order PDF')),
      amount: '30000',
      expiry: NOW + 86_400,
      approvedBlock: 1,
    });
    chain.rule = (_p, call) =>
      call.kind === 'pay' && call.checkerSig === '0x' ? 'PayToNotOnFile' : undefined;
    chain.onFile = '0x90f9931B748B26763161a8191C178Fe425C25fEd';
    const submitted = await post('/v1/payments', {
      account: ACCOUNT,
      vault: VAULT,
      payment: {
        amount: '1000',
        invoiceHash: keccak256(toHex('INV-0045')),
        payTo: SUPPLIER,
        deadline: NOW + 3600,
      },
      agentSig: AGENT_SIG,
    });
    const { request } = (await submitted.json()) as { request: { id: string; statusUrl: string } };
    expect(request.statusUrl).toBe(`${PUBLIC}/p/${request.id}`);
    const { checkOne } = await import('../src/pipeline/check.js');
    const row = await store.get(request.id);
    if (!row) throw new Error('no row');
    await checkOne(
      {
        store,
        chain,
        checker: new TestChecker(generatePrivateKey(), 10143),
        chainId: 10143,
        checkerTimeoutMs: 2_000,
      },
      row,
    );
    const page = await app.request(`/p/${request.id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(
      'The invoice&#39;s payment address is not the supplier&#39;s address on file.',
    );
    const text = html.replaceAll(/<[^>]+>/g, '');
    // Both addresses in full (shortening hides what an attacker changes), the difference marked.
    expect(text).toContain('0x90f9931B748B26763161a8191C178Fe425C25fEd');
    expect(text).toContain(SUPPLIER);
    expect(html).toContain('<mark>d</mark>');
    expect(html).toContain('0.001 USDC');
    // Read like a receipt: the supplier by name, hex only in the technical details.
    expect(html).toContain('Kalibre Studio');
    const [visible] = html.split('<details');
    expect(visible).not.toContain(request.id);
    expect(html.split('<details')[1]).toContain(request.id);
  });

  it('shows a paid payment with its times and a link to the explorer, not its hash', async () => {
    chain.rule = undefined;
    const submitted = await post('/v1/payments', {
      account: ACCOUNT,
      vault: VAULT,
      payment: {
        amount: '1000',
        invoiceHash: keccak256(toHex('INV-0046')),
        payTo: SUPPLIER,
        deadline: NOW + 3600,
      },
      agentSig: AGENT_SIG,
    });
    const { request } = (await submitted.json()) as { request: { id: string } };
    const tx = `0x${'ab'.repeat(32)}`;
    await store.transition(request.id, 'requested', 'checking');
    await store.transition(request.id, 'checking', 'released', {
      checkerSig: AGENT_SIG,
      decidedBy: 'checker',
    });
    await store.transition(request.id, 'released', 'settling', { txHash: tx, sentAt: new Date() });
    await store.transition(request.id, 'settling', 'settled', {
      blockNumber: 7,
      finalizedAt: new Date(),
    });
    const html = await (await app.request(`/p/${request.id}`)).text();
    expect(html).toContain('Paid');
    expect(html).toContain('View on the Monad explorer');
    expect(html).toMatch(/UTC/);
    // Shown as a link to the explorer, not as a hash a person has to read.
    const visibleText = (html.split('<details')[0] ?? '').replaceAll(/<[^>]+>/g, '');
    expect(visibleText).not.toContain(tx);
  });

  it('escapes what an agent wrote', async () => {
    const res = await post('/v1/proposals', {
      account: ACCOUNT,
      supplier: { name: '<script>alert(1)</script>', payTo: SUPPLIER },
      order: { amount: '1000', expiry: NOW + 86_400 },
      documentHash: keccak256(toHex('quote X')),
    });
    const { proposal } = (await res.json()) as { proposal: { id: string } };
    const html = await (await app.request(`/p/${proposal.id}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('answers 404 for an id it does not know', async () => {
    expect((await app.request(`/p/0x${'00'.repeat(32)}`)).status).toBe(404);
  });
});
