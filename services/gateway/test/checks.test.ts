import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { TestChecker, type Checker } from '../src/checker.js';
import { requestId } from '../src/ids.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

let database: Database;
let store: Store;
let chain: FakeChain;
const TOKEN = 'test-service-token-0123456789';
const CHAIN_ID = 10143;
const checkerKey = generatePrivateKey();

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
});

function appWith(checker: Checker) {
  return createApp({
    store,
    chain,
    checker,
    chainId: CHAIN_ID,
    checkerTimeoutMs: 200,
    token: TOKEN,
    health: () => Promise.resolve({}),
  });
}
const body = (invoice: string) => ({
  account: ACCOUNT,
  vault: VAULT,
  payment: {
    amount: '1000',
    invoiceHash: keccak256(toHex(invoice)),
    payTo: SUPPLIER,
    deadline: 1_791_400_000,
  },
  agentSig: AGENT_SIG,
});
async function check(checker: Checker, invoice: string) {
  const res = await appWith(checker).request('/v1/checks', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body(invoice)),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /v1/checks (a check with no payment)', () => {
  it('says a clean payment would settle, and stores, signs and sends nothing', async () => {
    const checker = new TestChecker(checkerKey, CHAIN_ID);
    const { status, body: result } = await check(checker, 'INV-dry-clean');
    expect(status).toBe(200);
    expect(result).toMatchObject({ verdict: 'would_settle', reason: null, decidedBy: 'checker' });
    expect(JSON.stringify(result)).not.toMatch(/checkerSig|0x[0-9a-f]{130}/);
    expect(checker.lastSignature).toBeUndefined(); // a dry run never produces a usable signature
    const id = requestId(ACCOUNT, VAULT, keccak256(toHex('INV-dry-clean')));
    expect(await store.get(id)).toBeUndefined();
  });

  it('holds an address not on file, with both addresses', async () => {
    chain.rule = (_p, call) =>
      call.kind === 'pay' && call.checkerSig === '0x' ? 'PayToNotOnFile' : undefined;
    chain.onFile = '0x90f9931B748B26763161a8191C178Fe425C25fEd';
    const { body: result } = await check(new TestChecker(checkerKey, CHAIN_ID), 'INV-dry-moved');
    expect(result).toMatchObject({
      verdict: 'held',
      reason: 'address_mismatch',
      decidedBy: 'rule',
      evidence: {
        payTo: { onFile: '0x90f9931B748B26763161a8191C178Fe425C25fEd', invoice: SUPPLIER },
      },
    });
  });

  it('blocks what the contract would never pay', async () => {
    chain.rule = () => 'OverRemaining';
    const { body: result } = await check(new TestChecker(checkerKey, CHAIN_ID), 'INV-dry-over');
    expect(result).toMatchObject({ verdict: 'blocked', reason: 'over_limit' });
  });

  it('holds what the checker holds, and fails closed when it is slow', async () => {
    const holding = new TestChecker(checkerKey, CHAIN_ID, () => 'amount_mismatch');
    expect((await check(holding, 'INV-dry-padded')).body).toMatchObject({
      verdict: 'held',
      reason: 'amount_mismatch',
      decidedBy: 'checker',
    });
    const slow: Checker = {
      check: (_input, startTimer) =>
        new Promise((_resolve, reject) => {
          startTimer().addEventListener('abort', () => {
            reject(new Error('timed out'));
          });
        }),
    };
    expect((await check(slow, 'INV-dry-slow')).body).toMatchObject({
      verdict: 'held',
      reason: 'checker_unavailable',
    });
  });

  it('answers 503 when the chain cannot be asked, rather than guessing', async () => {
    chain.simulate = () => Promise.reject(new Error('rpc down'));
    const { status, body: result } = await check(
      new TestChecker(checkerKey, CHAIN_ID),
      'INV-dry-down',
    );
    expect(status).toBe(503);
    expect(result).toEqual({ error: 'chain_unavailable' });
  });
});
