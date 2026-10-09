import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { supplierId, supplierSlug } from '@countersign/shared';
import { KALIBRE as KALIBRE_SITE } from '../../../apps/supplier/lib/documents.js';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { bankChallenge, KNOWN_BANKS, type AdviceInput, type Advisor } from '../src/advice.js';
import { hashToken, newAccountToken } from '../src/api/account-tokens.js';
import { SoftPasskey } from '../scripts/passkey.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, FakeChain, VAULT } from './fakes.js';

/**
 * Slice 17: advice on an invoice paid by bank transfer. The agent asks; the checker compares the
 * invoice's bank account with the one the owner put on file (with their passkey); the advice is
 * kept for the payment record. No payment request, no money: a bank transfer cannot be stopped
 * from outside the bank.
 */
let database: Database;
let store: Store;
let chain: FakeChain;
let advisor: FakeAdvisor;
let app: ReturnType<typeof createApp>;
const TOKEN = 'test-service-token-0123456789';
const CHAIN_ID = 10143;
const KALIBRE_ID = supplierId(supplierSlug('Kalibre Studio'));
const owner = SoftPasskey.fromScalar(`0x${'41'.repeat(32)}`);
const stranger = SoftPasskey.fromScalar(`0x${'42'.repeat(32)}`);
const INVOICE = '<main><h1>Invoice KS-1008</h1><p>IBAN GB29 NWBK 6016 1331 9268 19</p></main>';

class FakeAdvisor implements Advisor {
  asked: AdviceInput[] = [];
  answer: Awaited<ReturnType<Advisor['advise']>> = {
    advice: 'match',
    evidence: { read: { number: 'KS-1008' } },
  };
  fail = false;
  advise(input: AdviceInput) {
    this.asked.push(input);
    return this.fail
      ? Promise.reject(new Error('the checker answered 502'))
      : Promise.resolve(this.answer);
  }
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
  chain = new FakeChain();
  chain.ownerKeys = [{ qx: owner.qx, qy: owner.qy }];
  advisor = new FakeAdvisor();
  app = createApp({
    store,
    chain,
    checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
    advisor,
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
    supplierId: KALIBRE_ID,
    orderHash: keccak256(stringToHex('a quote')),
    amount: '5000',
    expiry: 2_000_000_000,
    approvedBlock: 10,
  });
});

const ask = (body: Record<string, unknown>, token = TOKEN) =>
  app.request('/v1/advice', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ account: ACCOUNT, vault: VAULT, document: { html: INVOICE }, ...body }),
  });

const BANK = { holder: 'Kalibre Studio Ltd', iban: 'GB29 NWBK 6016 1331 9268 19', bic: 'nwbkgb2l' };

const preview = (bank: unknown, supplier: Hex = KALIBRE_ID, account: Address = ACCOUNT) =>
  app.request(`/v1/owner/${account}/banks/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://approver.example' },
    body: JSON.stringify({ supplierId: supplier, bank }),
  });
const putOnFile = (bank: unknown, key: SoftPasskey, challenge: Hex) => {
  const a = key.sign(challenge);
  return app.request(`/v1/owner/${ACCOUNT}/banks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://approver.example' },
    body: JSON.stringify({
      supplierId: KALIBRE_ID,
      bank,
      assertion: {
        authenticatorData: a.authenticatorData,
        clientDataJSON: a.clientDataJSON,
        signature: { r: a.r, s: a.s },
      },
    }),
  });
};

describe('asking for advice on a bank-transfer invoice', () => {
  it('asks the checker with the order’s facts and the account on file, and keeps the advice', async () => {
    const res = await ask({});
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ advice: 'match', invoiceNumber: 'KS-1008' });
    expect(String(out.said)).toMatch(/^Advice:/);
    expect(String(out.said)).toMatch(/cannot stop/i);
    const input = advisor.asked[0];
    expect(input?.order).toMatchObject({ supplierId: KALIBRE_ID, addressOnFile: chain.onFile });
    expect(input?.invoice).toEqual({ html: INVOICE });
    // Kalibre is the demo supplier: its account is known, as its website is (Slice 15).
    expect(input?.bankOnFile).toEqual(KNOWN_BANKS[KALIBRE_ID.toLowerCase()]);
    expect(out.onFile).toMatchObject({ source: 'demo', iban: 'GB29NWBK60161331926819' });

    const kept = await store.adviceOf(ACCOUNT);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: out.id, advice: 'match', vault: VAULT.toLowerCase() });
    // Advice is not a payment: no request was made.
    expect(await store.listRun('none')).toEqual([]);
    expect(await store.get(out.id as Hex)).toBeUndefined();
  });

  it('keeps one record per invoice: asking again updates it', async () => {
    const first = (await (await ask({})).json()) as { id: string };
    advisor.answer = { advice: 'mismatch', reason: 'bank_account_mismatch', evidence: {} };
    const second = (await (await ask({})).json()) as { id: string; advice: string; said: string };
    expect(second.id).toBe(first.id);
    expect(second.advice).toBe('mismatch');
    expect(second.said).toMatch(/do not pay/i);
    expect(second.said).toMatch(/phone/i);
    expect(await store.adviceOf(ACCOUNT)).toHaveLength(1);
  });

  it('is unsure, never a match, when the checker does not answer', async () => {
    advisor.fail = true;
    const out = (await (await ask({})).json()) as Record<string, unknown>;
    expect(out).toMatchObject({ advice: 'unsure', reason: 'checker_unavailable' });
    expect(String(out.said)).toMatch(/unsure/i);
  });

  it('refuses an order that is not this account’s, and another account’s token', async () => {
    const other = '0x5555555555555555555555555555555555555555';
    expect((await ask({ vault: other })).status).toBe(404);
    const token = newAccountToken();
    await store.registerAccount(other, 1);
    await store.issueApiToken(other, hashToken(token), 1);
    expect((await ask({}, token)).status).toBe(403);
  });

  it('answers 503 when the checker gives no advice here', async () => {
    const without = createApp({
      store,
      chain,
      checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
      chainId: CHAIN_ID,
      checkerTimeoutMs: 2_000,
      token: TOKEN,
      health: () => Promise.resolve({}),
    });
    const res = await without.request('/v1/advice', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ account: ACCOUNT, vault: VAULT, document: 'Invoice KS-1008' }),
    });
    expect(res.status).toBe(503);
  });

  it('knows the demo supplier’s account exactly as the demo site prints it', () => {
    const known = KNOWN_BANKS[KALIBRE_ID.toLowerCase()];
    expect(known?.holder).toBe(KALIBRE_SITE.bank.holder);
    expect(known?.iban).toBe(KALIBRE_SITE.bank.iban.replace(/\s/g, ''));
    expect(known?.bic).toBe(KALIBRE_SITE.bank.bic);
  });
});

describe('an owner putting a supplier’s bank account on file, with their passkey', () => {
  it('shows what will be signed, then keeps it, and advice uses it from then on', async () => {
    const res = await preview(BANK);
    expect(res.status).toBe(200);
    const p = (await res.json()) as { challenge: Hex; summary: string; bank: unknown };
    const normal = {
      holder: 'Kalibre Studio Ltd',
      iban: 'GB29NWBK60161331926819',
      bic: 'NWBKGB2L',
    };
    expect(p.bank).toEqual(normal);
    expect(p.challenge).toBe(bankChallenge(CHAIN_ID, ACCOUNT, KALIBRE_ID, normal));
    expect(p.summary).toContain('GB29 NWBK 6016 1331 9268 19');

    const put = await putOnFile(BANK, owner, p.challenge);
    expect(put.status).toBe(200);
    expect(await store.supplierBank(ACCOUNT, KALIBRE_ID)).toMatchObject({
      holder: 'Kalibre Studio Ltd',
      iban: 'GB29NWBK60161331926819',
    });

    await ask({});
    expect(advisor.asked[0]?.bankOnFile).toEqual(normal);
    const list = await app.request(`/v1/accounts/${ACCOUNT}/banks`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await list.json()).toMatchObject({
      account: ACCOUNT,
      banks: [{ supplierId: KALIBRE_ID.toLowerCase(), iban: 'GB29NWBK60161331926819' }],
    });
  });

  it('refuses a stranger’s passkey, and a signature over other details', async () => {
    const p = (await (await preview(BANK)).json()) as { challenge: Hex };
    expect((await putOnFile(BANK, stranger, p.challenge)).status).toBe(422);
    const other = { ...BANK, iban: 'GB33 BUKB 2020 1555 5555 55' };
    const res = await putOnFile(other, owner, p.challenge);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'challenge_mismatch' });
    expect(await store.supplierBank(ACCOUNT, KALIBRE_ID)).toBeUndefined();
  });

  it('refuses an account whose check digits fail, and a supplier the account has no order with', async () => {
    const bad = await preview({ ...BANK, iban: 'GB30 NWBK 6016 1331 9268 19' });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: 'invalid_bank' });
    const unknown = await preview(BANK, supplierId(supplierSlug('Northwind Prints')));
    expect(unknown.status).toBe(404);
    expect((await preview({ holder: 'Kalibre Studio Ltd' })).status).toBe(400);
  });
});
