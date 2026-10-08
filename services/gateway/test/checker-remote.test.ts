import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { invoiceHash, supplierId, supplierSlug } from '@countersign/shared';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import type { PaymentRequestRow } from '../src/db/schema.js';
import { RemoteChecker, orderFacts } from '../src/checker-remote.js';
import { DEMO_QUOTE } from '../src/demo/invoices.js';
import { freshDatabase, truncate } from './db/helpers.js';

let database: Database;
let store: Store;
const ACCOUNT: Address = '0x4444444444444444444444444444444444444444';
const VAULT: Address = '0x6c033066C05Eb524119c8C830F937C4bbd17E426';
const KALIBRE: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
const KALIBRE_ID = supplierId(supplierSlug('Kalibre Studio'));
const QUOTE = 'Kalibre Studio — Product photography\nQuote Q-1\nTotal: 0.005 USDC';
const chain = { addressOnFile: () => Promise.resolve(KALIBRE) };

const row = (document: unknown): PaymentRequestRow =>
  ({
    id: `0x${'aa'.repeat(32)}`,
    account: ACCOUNT,
    vault: VAULT,
    invoiceHash: invoiceHash(KALIBRE_ID, 'KS-1'),
    payTo: KALIBRE,
    amount: '1000',
    deadline: 2_000_000_000,
    document,
  }) as PaymentRequestRow;
const payment = {
  amount: 1_000n,
  invoiceHash: invoiceHash(KALIBRE_ID, 'KS-1'),
  payTo: KALIBRE,
  deadline: 2_000_000_000n,
};
async function order(orderHash: Hex) {
  await store.registerAccount(ACCOUNT, 1);
  await store.upsertOrder({
    vault: VAULT,
    account: ACCOUNT,
    orderId: keccak256(stringToHex('order 1')),
    supplierId: KALIBRE_ID,
    orderHash,
    amount: '5000',
    expiry: 2_000_000_000,
    approvedBlock: 10,
  });
}

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
});

describe('what the gateway tells the checker about the order (Slice 10)', () => {
  it('gives the quote the owner approved through a proposal, with the supplier’s name', async () => {
    const documentHash = keccak256(stringToHex(QUOTE));
    await order(documentHash);
    const { proposal } = await store.createProposal({
      id: keccak256(stringToHex('proposal 1')),
      account: ACCOUNT,
      supplierName: 'Kalibre Studio',
      website: null,
      payTo: KALIBRE,
      amount: '5000',
      expiry: 2_000_000_000,
      documentHash,
      document: QUOTE,
    });
    await store.decideProposal(proposal.id, 'approved');
    expect(await orderFacts({ store, chain }, row(null))).toEqual({
      supplierId: KALIBRE_ID,
      supplierName: 'Kalibre Studio',
      addressOnFile: KALIBRE,
      quote: { text: QUOTE },
    });
  });

  it('gives a judge’s demo order its quote, and no quote for an order opened without one', async () => {
    await order(keccak256(stringToHex(DEMO_QUOTE)));
    expect((await orderFacts({ store, chain }, row(null)))?.quote).toEqual({ text: DEMO_QUOTE });
    await truncate(database);
    await order(keccak256(stringToHex('demo order')));
    expect((await orderFacts({ store, chain }, row(null)))?.quote).toBeNull();
  });

  it('knows nothing of an order not yet indexed', async () => {
    expect(await orderFacts({ store, chain }, row(null))).toBeNull();
  });
});

describe('asking the checker service', () => {
  const facts = () =>
    Promise.resolve({
      supplierId: KALIBRE_ID,
      supplierName: 'Kalibre Studio',
      addressOnFile: KALIBRE,
      quote: null,
    });
  const answering = (
    status: number,
    body: unknown,
    seen?: { body?: unknown; auth?: string | null },
  ) =>
    ((_url: string, init?: RequestInit) => {
      if (seen) {
        seen.body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        seen.auth = new Headers(init?.headers).get('authorization');
      }
      return Promise.resolve(Response.json(body, { status }));
    }) as typeof fetch;
  const checkerWith = (fetchFn: typeof fetch) =>
    new RemoteChecker({ url: 'https://checker.test', token: 'checker-token', facts, fetchFn });
  const input = (document: unknown) => ({ request: row(document), payment, chainId: 10143 });

  it('sends the payment, the order and the invoice as the agent gave it, with its token', async () => {
    const seen: { body?: unknown; auth?: string | null } = {};
    const sig = `0x${'ab'.repeat(65)}`;
    const r = await checkerWith(
      answering(200, { verdict: 'release', checkerSig: sig, evidence: { ok: 1 } }, seen),
    ).check(input({ text: 'Invoice KS-1' }), AbortSignal.timeout(1_000));
    expect(r).toEqual({ verdict: 'release', checkerSig: sig, evidence: { ok: 1 } });
    expect(seen.auth).toBe('Bearer checker-token');
    expect(seen.body).toMatchObject({
      payment: { chainId: 10143, vault: VAULT, amount: '1000', payTo: KALIBRE },
      order: { supplierId: KALIBRE_ID, addressOnFile: KALIBRE },
      invoice: { text: 'Invoice KS-1' },
    });
  });

  it('passes a page as HTML, a string as text, and nothing readable as empty text', async () => {
    const seen: { body?: unknown } = {};
    const fetchFn = answering(
      200,
      { verdict: 'hold', reason: 'checker_unsure', evidence: {} },
      seen,
    );
    await checkerWith(fetchFn).check(input({ html: '<p>x</p>' }), AbortSignal.timeout(1_000));
    expect(seen.body).toMatchObject({ invoice: { html: '<p>x</p>' } });
    await checkerWith(fetchFn).check(input('plain text'), AbortSignal.timeout(1_000));
    expect(seen.body).toMatchObject({ invoice: { text: 'plain text' } });
    await checkerWith(fetchFn).check(input({ fields: 1 }), AbortSignal.timeout(1_000));
    expect(seen.body).toMatchObject({ invoice: { text: '' } });
  });

  it('holds what it cannot trust: an unknown reason, a release without a signature, an order not indexed', async () => {
    expect(
      await checkerWith(
        answering(200, { verdict: 'hold', reason: 'nonsense', evidence: {} }),
      ).check(input(null), AbortSignal.timeout(1_000)),
    ).toMatchObject({ verdict: 'hold', reason: 'checker_unsure' });
    expect(
      await checkerWith(
        answering(200, { verdict: 'release', checkerSig: '0x', evidence: {} }),
      ).check(input(null), AbortSignal.timeout(1_000)),
    ).toMatchObject({ verdict: 'hold', reason: 'checker_unsure' });
    const unknown = new RemoteChecker({
      url: 'https://checker.test',
      token: 't',
      facts: () => Promise.resolve(null),
      fetchFn: answering(200, {}),
    });
    expect(await unknown.check(input(null), AbortSignal.timeout(1_000))).toMatchObject({
      verdict: 'hold',
      reason: 'checker_unsure',
    });
  });

  it('throws when the checker does not answer properly, which the pipeline holds', async () => {
    await expect(
      checkerWith(answering(500, { error: 'internal' })).check(
        input(null),
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toThrow(/500/);
  });
});
