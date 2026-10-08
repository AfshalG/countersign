import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { supplierId } from '@countersign/shared';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { TestChecker } from '../../src/checker.js';
import { checkOne } from '../../src/pipeline/check.js';
import { KALIBRE_FILE, WebsiteProofs } from '../../src/proofs/website.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, VAULT } from '../fakes.js';

/**
 * Slice 15 part 2: a changed-address hold says what the supplier's own website (the one on file)
 * lists: the address on file, the invoice's, or neither.
 */
let database: Database;
let store: Store;
let chain: FakeChain;
let app: ReturnType<typeof createApp>;
let proves: number;
let lists: Address;
const CHAIN_ID = 10143;
const TOKEN = 'test-service-token-0123456789';
const KALIBRE: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
const LOOK_ALIKE: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEd';
const TX: Hex = `0x${'ef'.repeat(32)}`;
const checker = new TestChecker(generatePrivateKey(), CHAIN_ID);
const REAL = JSON.parse(
  readFileSync(new URL('fixtures/attestation-supplier.json', import.meta.url), 'utf8'),
) as { data: string; timestamp: number };

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
  proves = 0;
  lists = KALIBRE;
  const websites = new WebsiteProofs({
    store,
    // Primus's answer, as fresh as now, listing whatever the test says the site lists.
    prover: {
      prove: () => {
        proves++;
        return Promise.resolve({ ...REAL, data: `{"payTo":"${lists}"}`, timestamp: Date.now() });
      },
    },
    recorder: { record: () => Promise.resolve(TX) },
    onFile: () => Promise.resolve(true),
    fetch: () => Promise.resolve(new Response(`{"payTo":"${lists}"}`, { status: 200 })),
  });
  app = createApp({
    store,
    chain,
    checker,
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
    websites,
  });
  await store.upsertOrder({
    vault: VAULT,
    account: ACCOUNT,
    orderId: keccak256(toHex('order 1')),
    supplierId: supplierId('kalibre-studio'),
    orderHash: keccak256(toHex('quote')),
    amount: '30000',
    expiry: Math.floor(Date.now() / 1000) + 86_400,
    approvedBlock: 950,
  });
});

/** An invoice to `payTo` while `onFile` is the supplier's address on file: held, address mismatch. */
async function heldFor(payTo: Address, onFile: Address) {
  chain.onFile = onFile;
  chain.rule = (_p, call) =>
    call.kind === 'pay' && call.checkerSig === '0x' ? 'PayToNotOnFile' : undefined;
  const res = await app.request('/v1/payments', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      account: ACCOUNT,
      vault: VAULT,
      payment: {
        amount: '1000',
        invoiceHash: keccak256(toHex(`invoice ${payTo}`)),
        payTo,
        deadline: 1_791_400_000,
      },
      agentSig: AGENT_SIG,
    }),
  });
  const { request } = (await res.json()) as { request: { id: Hex } };
  const row = await store.get(request.id);
  if (!row) throw new Error('no row');
  await checkOne({ store, chain, checker, chainId: CHAIN_ID, checkerTimeoutMs: 2_000 }, row);
  chain.rule = undefined;
  expect((await store.get(request.id))?.status).toBe('held');
  return request.id;
}

type Proof = { status: string; matches?: string; site: string | null; text: string; url: string };
const websiteOf = async (id: string) => {
  for (let i = 0; i < 50; i++) {
    const view = (await (await app.request(`/v1/approvals/${id}`)).json()) as {
      summary: { websiteProof?: Proof | null };
    };
    const proof = view.summary.websiteProof;
    if (proof?.status !== 'checking') return proof;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('still checking');
};

describe('the supplier’s website on a changed-address hold', () => {
  it('still lists the address on file: said in plain words, from the site on file', async () => {
    const id = await heldFor(LOOK_ALIKE, KALIBRE);
    const proof = await websiteOf(id);
    expect(proof).toMatchObject({
      status: 'verified',
      matches: 'on_file',
      url: KALIBRE_FILE,
      site: 'countersign-supplier-demo.vercel.app',
    });
    expect(proof?.text).toContain('still lists the address on file');
    expect(proves).toBe(1);
  });

  it('lists the invoice’s address instead: the supplier may have changed it, so change it on file first', async () => {
    lists = LOOK_ALIKE;
    const id = await heldFor(LOOK_ALIKE, KALIBRE);
    const proof = await websiteOf(id);
    expect(proof).toMatchObject({ status: 'not_listed', matches: 'invoice' });
    expect(proof?.text).toContain('change it on file');
  });

  it('lists neither: said so', async () => {
    lists = '0x7777777777777777777777777777777777777777';
    const id = await heldFor(LOOK_ALIKE, KALIBRE);
    expect(await websiteOf(id)).toMatchObject({ status: 'not_listed', matches: 'neither' });
  });

  it('a supplier with no website on file: said so, and nothing is proven', async () => {
    // Not Kalibre: an order for a supplier with no known site.
    await database.db.execute(
      sql`update orders set supplier_id = ${supplierId('northwind-prints')}`,
    );
    const id = await heldFor(LOOK_ALIKE, KALIBRE);
    expect(await websiteOf(id)).toMatchObject({ status: 'unavailable' });
    expect(proves).toBe(0);
  });

  it('a hold for another reason shows no website check', async () => {
    chain.onFile = KALIBRE;
    const res = await app.request('/v1/payments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        account: ACCOUNT,
        vault: VAULT,
        payment: {
          amount: '1000',
          invoiceHash: keccak256(toHex('amount hold')),
          payTo: KALIBRE,
          deadline: 1_791_400_000,
        },
        agentSig: AGENT_SIG,
      }),
    });
    const { request } = (await res.json()) as { request: { id: Hex } };
    await store.transition(request.id, 'requested', 'checking');
    await store.transition(request.id, 'checking', 'held', {
      reason: 'amount_mismatch',
      decidedBy: 'checker',
    });
    const view = (await (await app.request(`/v1/approvals/${request.id}`)).json()) as {
      summary: { websiteProof?: unknown };
    };
    expect(view.summary.websiteProof ?? null).toBeNull();
  });
});
