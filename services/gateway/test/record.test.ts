import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, stringToHex, toHex, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { evidenceHash, OUTCOME, reasonHash, supplierId, supplierSlug } from '@countersign/shared';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { relayerTxs } from '../src/db/schema.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { checkOne } from '../src/pipeline/check.js';
import { DecisionRecorder } from '../src/decisions.js';
import type { Signed } from '../src/relay/pool.js';
import { hashToken, newAccountToken } from '../src/api/account-tokens.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

/**
 * Slice 18: one file per payment an auditor can check without trusting Countersign: the payment,
 * the document, the checks and their evidence hash, the decision and where it is on Monad, the
 * settlement, every event. And one CSV across an account.
 */
let database: Database;
let store: Store;
let chain: FakeChain;
let app: ReturnType<typeof createApp>;
const TOKEN = 'test-service-token-0123456789';
const CHAIN_ID = 10143;
const DOCUMENT = { text: 'Kalibre Studio — Invoice KS-1003\nTotal: 0.001 USDC' };

/** A pool that signs nothing real, and leaves a row the finality tracker would mark. */
const pool = {
  sign: async (_tx: unknown, attach?: string | { purpose: string }) => {
    const purpose = typeof attach === 'object' ? attach.purpose : String(attach);
    const hash = keccak256(stringToHex(purpose));
    await database.db.insert(relayerTxs).values({
      hash,
      relayer: SUPPLIER,
      nonce: 1,
      raw: '0x01',
      purpose,
    });
    return { relayer: SUPPLIER, nonce: 1, raw: '0x01', hash } as Signed;
  },
  enqueue: () => undefined,
};

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
  app = createApp({
    store,
    chain,
    checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
  });
  await store.registerAccount(ACCOUNT, 1);
  await store.upsertOrder({
    vault: VAULT,
    account: ACCOUNT,
    orderId: keccak256(stringToHex('order 1')),
    supplierId: supplierId(supplierSlug('Kalibre Studio')),
    orderHash: keccak256(stringToHex('a quote')),
    amount: '5000',
    expiry: 2_000_000_000,
    approvedBlock: 10,
  });
});

async function submit(invoice: string): Promise<Hex> {
  const res = await app.request('/v1/payments', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      account: ACCOUNT,
      vault: VAULT,
      payment: {
        amount: '1000',
        invoiceHash: keccak256(toHex(invoice)),
        payTo: SUPPLIER,
        deadline: 1_791_400_000,
      },
      agentSig: AGENT_SIG,
      document: DOCUMENT,
    }),
  });
  return ((await res.json()) as { request: { id: Hex } }).request.id;
}

const record = async (id: string, token = TOKEN) =>
  app.request(`/v1/payments/${id}/record`, { headers: { authorization: `Bearer ${token}` } });
type Rec = Record<string, Record<string, unknown> & { onChain?: unknown }>;

describe('a payment’s record', () => {
  it('holds a checker’s hold, its evidence hash and its decision on Monad, as one chain', async () => {
    const id = await submit('KS-1003');
    const row = await store.get(id);
    if (!row) throw new Error('no row');
    const recorder = new DecisionRecorder({ store, pool, enabled: true });
    await checkOne(
      {
        store,
        chain,
        checker: new TestChecker(generatePrivateKey(), CHAIN_ID, () => 'items_mismatch'),
        chainId: CHAIN_ID,
        checkerTimeoutMs: 2_000,
        decisions: recorder,
      },
      row,
    );
    const tx = (await store.decisionRecord(id, 'checker'))?.txHash as Hex;
    await store.markRelayerTxFinal(tx, 'success', 4242);

    const res = await record(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="countersign-record-${id}.json"`,
    );
    const r = (await res.json()) as Rec;
    const stored = await store.get(id);
    expect(r.format).toBe('countersign-record/1');
    expect(r.payment).toMatchObject({
      id,
      account: ACCOUNT,
      vault: VAULT,
      invoiceHash: keccak256(toHex('KS-1003')),
      amountUsdc: '0.001',
      order: { supplierId: supplierId(supplierSlug('Kalibre Studio')) },
    });
    expect(r.document).toEqual({ content: DOCUMENT, hash: evidenceHash(DOCUMENT) });
    expect(r.check).toMatchObject({
      status: 'held',
      reason: 'items_mismatch',
      decidedBy: 'checker',
      evidence: stored?.evidence,
      evidenceHash: evidenceHash(stored?.evidence),
    });
    expect(r.decision?.onChain).toMatchObject([
      {
        by: 'checker',
        decision: {
          invoiceHash: keccak256(toHex('KS-1003')),
          outcome: OUTCOME.held,
          reasonHash: reasonHash('items_mismatch'),
          evidenceHash: evidenceHash(stored?.evidence),
        },
        tx: { hash: tx, block: 4242, status: 'success', final: true },
      },
    ]);
    expect(r.settlement).toBeNull();
    expect((r.events as unknown as { to: string }[]).map((e) => e.to)).toEqual([
      'requested',
      'checking',
      'held',
    ]);
    expect((r.verify as unknown as string[]).join(' ')).toMatch(/countersign-verify/);
    // The public page says so too, with the transaction.
    const page = await (await app.request(`/p/${id}`)).text();
    expect(page).toContain('Hold on Monad');
    expect(page).toContain(`/tx/${tx}`);
  });

  it('holds a settled payment’s transaction, and says nothing else needed recording', async () => {
    const id = await submit('KS-1001');
    const sig: Hex = `0x${'aa'.repeat(65)}`;
    const now = new Date();
    await store.transition(id, 'requested', 'checking');
    await store.transition(id, 'checking', 'released', {
      checkedAt: now,
      decidedBy: 'checker',
      checkerSig: sig,
      evidence: { checker: 'test' },
    });
    const txHash = keccak256(stringToHex('settlement'));
    await store.transition(id, 'released', 'settling', {
      txHash,
      relayer: SUPPLIER,
      relayerNonce: 3,
      sentAt: now,
    });
    await store.transition(id, 'settling', 'settled', { blockNumber: 777, finalizedAt: now });
    const r = (await (await record(id)).json()) as Rec;
    expect(r.settlement).toMatchObject({
      tx: { hash: txHash, block: 777, relayer: SUPPLIER },
      checkerSig: sig,
    });
    expect(r.decision?.onChain).toEqual([]);
    expect(String(r.decision?.onChainNote)).toMatch(/PaymentExecuted/);
  });

  it('says why a hold by the contract’s own rules is not on chain', async () => {
    chain.rule = (_p, call) =>
      call.kind === 'pay' && call.checkerSig === '0x' ? 'PayToNotOnFile' : undefined;
    const id = await submit('KS-1002');
    const row = await store.get(id);
    if (!row) throw new Error('no row');
    await checkOne(
      {
        store,
        chain,
        checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
        chainId: CHAIN_ID,
        checkerTimeoutMs: 2_000,
        decisions: new DecisionRecorder({ store, pool, enabled: true }),
      },
      row,
    );
    const r = (await (await record(id)).json()) as Rec;
    expect(r.check).toMatchObject({ status: 'held', decidedBy: 'rule' });
    expect(r.decision?.onChain).toEqual([]);
    expect(String(r.decision?.onChainNote)).toMatch(/contract’s own rules/);
  });

  it('is only for the payment’s own account', async () => {
    const id = await submit('KS-1004');
    const other = '0x5555555555555555555555555555555555555555';
    const token = newAccountToken();
    await store.registerAccount(other, 1);
    await store.issueApiToken(other, hashToken(token), 1);
    expect((await record(id, token)).status).toBe(404);
    expect((await record(`0x${'99'.repeat(32)}`)).status).toBe(404);
  });
});

describe('an account’s records as one CSV', () => {
  it('lists every payment and every piece of advice, one row each, newest first', async () => {
    const paid = await submit('KS-1001');
    await submit('KS-1005');
    await store.recordAdvice({
      id: keccak256(stringToHex('advice 1')),
      account: ACCOUNT.toLowerCase(),
      vault: VAULT.toLowerCase(),
      supplierId: supplierId(supplierSlug('Kalibre Studio')),
      advice: 'mismatch',
      reason: 'bank_account_mismatch',
      invoiceNumber: 'KS-1007',
      documentHash: keccak256(stringToHex('doc')),
      evidence: { read: { number: 'KS-1007' } },
    });
    const res = await app.request(`/v1/accounts/${ACCOUNT}/records.csv`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0]).toBe(
      'date,kind,id,invoice,supplier,amount_usdc,outcome,reason,decided_by,evidence_hash,decision_tx,settlement_tx,record',
    );
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.includes(',advice,') && l.includes('bank_account_mismatch'))).toBe(
      true,
    );
    const row = lines.find((l) => l.includes(paid));
    expect(row).toContain(`https://gateway.test/v1/payments/${paid}/record`);
    expect(row).toContain(',0.001,requested,');
  });
});
