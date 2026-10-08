import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { supplierId } from '@countersign/shared';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import type { PaymentRequestRow } from '../../src/db/schema.js';
import { TestChecker } from '../../src/checker.js';
import { evaluate } from '../../src/pipeline/check.js';
import { KALIBRE_FILE, WebsiteProofs } from '../../src/proofs/website.js';
import { requestId } from '../../src/ids.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, VAULT } from '../fakes.js';

/**
 * Slice 15 part 3, evidence that expires (D21): the websites of approved suppliers are checked
 * again each day, and a supplier whose site stops listing the address on file has its payments
 * held (`website_changed`) until the site lists it again. Only a proof counts: a check that could
 * not be made never holds a payment.
 */
let database: Database;
let store: Store;
let chain: FakeChain;
let websites: WebsiteProofs;
let proves: string[];
let clock: number;
const CHAIN_ID = 10143;
const KALIBRE: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
const ELSEWHERE: Address = '0x7777777777777777777777777777777777777777';
const NORTHWIND_FILE = 'https://northwind-prints-demo.vercel.app/.well-known/countersign.json';
const checker = new TestChecker(generatePrivateKey(), CHAIN_ID);
const HOUR = 3_600_000;

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
  chain.onFile = KALIBRE;
  proves = [];
  clock = Date.now();
  websites = new WebsiteProofs({
    store,
    prover: {
      prove: (url) => {
        proves.push(url);
        return Promise.reject(new Error('not used to prove here'));
      },
    },
    recorder: { record: () => Promise.reject(new Error('not used')) },
    onFile: () => Promise.resolve(true),
    fetch: () => Promise.resolve(new Response(`{"payTo":"${KALIBRE}"}`, { status: 200 })),
    now: () => clock,
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

/** A proven check of a file, `hoursAgo` hours ago, listing `listed`. */
const proven = (url: string, listed: Address, hoursAgo: number) =>
  store.addWebsiteProof({
    url,
    listed,
    signedAt: new Date(clock - hoursAgo * HOUR),
    proofHash: keccak256(toHex(`${url} ${listed} ${String(hoursAgo)}`)),
    txHash: `0x${'aa'.repeat(32)}`,
    createdAt: new Date(clock - hoursAgo * HOUR),
  });

function payment(): PaymentRequestRow {
  const invoiceHash = keccak256(toHex(`invoice ${String(Math.random())}`));
  const now = new Date();
  return {
    id: requestId(ACCOUNT, VAULT, invoiceHash),
    runId: null,
    account: ACCOUNT,
    vault: VAULT,
    invoiceHash,
    payTo: KALIBRE,
    amount: '1000',
    deadline: 1_791_400_000,
    agentSig: AGENT_SIG,
    agentAddress: null,
    document: null,
    status: 'checking',
    reason: null,
    decidedBy: null,
    evidence: null,
    checkerSig: null,
    ownerAuth: null,
    relayer: null,
    relayerNonce: null,
    rawTx: null,
    txHash: null,
    blockNumber: null,
    requestedAt: now,
    checkedAt: null,
    decidedAt: null,
    sentAt: null,
    proposedAt: null,
    votedAt: null,
    finalizedAt: null,
    updatedAt: now,
    leaseUntil: null,
  };
}
const decide = () =>
  evaluate({ chain, checker, chainId: CHAIN_ID, checkerTimeoutMs: 2_000, websites }, payment());

describe('a payment to a supplier whose website changed (D21)', () => {
  it('is held when the site listed the address on file before and lists another now', async () => {
    await proven(KALIBRE_FILE, KALIBRE, 30);
    const now = await proven(KALIBRE_FILE, ELSEWHERE, 1);
    const outcome = await decide();
    expect(outcome).toMatchObject({
      status: 'held',
      reason: 'website_changed',
      decidedBy: 'rule',
    });
    expect(outcome.evidence).toMatchObject({
      website: { url: KALIBRE_FILE, listed: ELSEWHERE, onFile: KALIBRE, proofHash: now.proofHash },
    });
  });

  it('goes on once the site lists the address on file again', async () => {
    await proven(KALIBRE_FILE, KALIBRE, 30);
    await proven(KALIBRE_FILE, ELSEWHERE, 2);
    await proven(KALIBRE_FILE, KALIBRE, 1);
    expect((await decide()).status).toBe('released');
  });

  it('is not held when the site never listed the address on file (the owner approved it by hand)', async () => {
    await proven(KALIBRE_FILE, ELSEWHERE, 1);
    expect((await decide()).status).toBe('released');
  });

  it('is not held when a check could not be made: only a proof counts', async () => {
    await proven(KALIBRE_FILE, KALIBRE, 30);
    await store.addWebsiteProof({
      url: KALIBRE_FILE,
      listed: ELSEWHERE,
      error: 'primus_failed',
      createdAt: new Date(clock - HOUR),
    });
    expect((await decide()).status).toBe('released');
  });

  it('is not held for a supplier with no website on file', async () => {
    await database.db.execute(
      // The order is for a supplier the gateway knows no site for.
      (await import('drizzle-orm'))
        .sql`update orders set supplier_id = ${supplierId('northwind-prints')}`,
    );
    await proven(KALIBRE_FILE, KALIBRE, 30);
    await proven(KALIBRE_FILE, ELSEWHERE, 1);
    expect((await decide()).status).toBe('released');
  });
});

describe('the daily check of approved suppliers’ websites', () => {
  it('checks each known site whose last check is over a day old, and only those', async () => {
    await store.setSupplierWebsite(ACCOUNT, supplierId('northwind-prints'), NORTHWIND_FILE);
    await proven(NORTHWIND_FILE, KALIBRE, 2); // checked two hours ago: not again yet
    await proven(KALIBRE_FILE, KALIBRE, 25); // over a day: checked again
    await websites.recheck();
    expect(proves).toEqual([KALIBRE_FILE]);
  });
});
