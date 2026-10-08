import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Reason } from '@countersign/shared';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { requestId } from '../../src/ids.js';
import { checkOne } from '../../src/pipeline/check.js';
import { TestChecker, type Checker } from '../../src/checker.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from '../fakes.js';

let database: Database;
let store: Store;
let chain: FakeChain;
const checkerKey = generatePrivateKey();
const CHAIN_ID = 10143;

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

async function submit(invoice: string) {
  const invoiceHash = keccak256(toHex(invoice));
  const { request } = await store.createRequest({
    id: requestId(ACCOUNT, VAULT, invoiceHash),
    account: ACCOUNT,
    vault: VAULT,
    invoiceHash,
    payTo: SUPPLIER,
    amount: 1_000n,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    agentSig: AGENT_SIG,
  });
  return request;
}

const run = (checker: Checker, request: Awaited<ReturnType<typeof submit>>) =>
  checkOne({ store, chain, checker, chainId: CHAIN_ID, checkerTimeoutMs: 2_000 }, request);

describe('the check step', () => {
  it('releases a payment that passes every contract rule and the checker, with the checker signature', async () => {
    const request = await submit('INV-clean');
    await run(new TestChecker(checkerKey, CHAIN_ID), request);
    const row = await store.get(request.id);
    expect(row?.status).toBe('released');
    expect(row?.decidedBy).toBe('checker');
    expect(row?.checkerSig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(row?.checkedAt).toBeInstanceOf(Date);
  });

  it('signs the vault-domain payment digest with the checker key', async () => {
    const request = await submit('INV-sig');
    const checker = new TestChecker(checkerKey, CHAIN_ID);
    await run(checker, request);
    const row = await store.get(request.id);
    expect(checker.lastSigner).toBe(privateKeyToAccount(checkerKey).address);
    expect(row?.checkerSig).toBe(checker.lastSignature);
  });

  it('holds what the contract would refuse to an address not on file, before asking the checker', async () => {
    chain.rule = (_p, call) =>
      call.kind === 'pay' && call.checkerSig === '0x' ? 'PayToNotOnFile' : undefined;
    const checker = new TestChecker(checkerKey, CHAIN_ID);
    const request = await submit('INV-moved');
    await run(checker, request);
    const row = await store.get(request.id);
    expect(row?.status).toBe('held');
    expect(row?.reason).toBe('address_mismatch');
    expect(row?.decidedBy).toBe('rule');
    expect(checker.calls).toBe(0);
  });

  it('records the address on file beside the invoice’s, so the owner can compare them', async () => {
    chain.rule = (_p, call) =>
      call.kind === 'pay' && call.checkerSig === '0x' ? 'PayToNotOnFile' : undefined;
    chain.onFile = '0x90f9931B748B26763161a8191C178Fe425C25fEd';
    const request = await submit('INV-lookalike');
    await run(new TestChecker(checkerKey, CHAIN_ID), request);
    const row = await store.get(request.id);
    expect(row?.status).toBe('held');
    expect(row?.evidence).toMatchObject({
      contract: 'PayToNotOnFile',
      payTo: { onFile: '0x90f9931B748B26763161a8191C178Fe425C25fEd', invoice: SUPPLIER },
    });
  });

  it('still holds an address not on file when the address on file cannot be read', async () => {
    chain.rule = (_p, call) =>
      call.kind === 'pay' && call.checkerSig === '0x' ? 'PayToNotOnFile' : undefined;
    chain.onFile = undefined;
    const request = await submit('INV-lookup-fails');
    await run(new TestChecker(checkerKey, CHAIN_ID), request);
    const row = await store.get(request.id);
    expect(row?.status).toBe('held');
    expect(row?.reason).toBe('address_mismatch');
    expect(row?.evidence).toMatchObject({
      contract: 'PayToNotOnFile',
      payTo: { invoice: SUPPLIER },
    });
  });

  it('blocks what nobody should pay (over what is left in the order)', async () => {
    chain.rule = () => 'OverRemaining';
    const request = await submit('INV-over');
    await run(new TestChecker(checkerKey, CHAIN_ID), request);
    const row = await store.get(request.id);
    expect(row?.status).toBe('blocked');
    expect(row?.reason).toBe('over_limit');
  });

  it('holds what the checker holds, with its reason', async () => {
    const request = await submit('INV-padded');
    const holdPadded = (): Reason => 'items_mismatch';
    await run(new TestChecker(checkerKey, CHAIN_ID, holdPadded), request);
    const row = await store.get(request.id);
    expect(row?.status).toBe('held');
    expect(row?.reason).toBe('items_mismatch');
    expect(row?.decidedBy).toBe('checker');
  });

  it('holds when the checker errors or runs out of time (fail closed)', async () => {
    const broken: Checker = { check: () => Promise.reject(new Error('model provider down')) };
    const slow: Checker = {
      check: (_input, startTimer) =>
        new Promise((_resolve, reject) => {
          startTimer().addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    };
    const a = await submit('INV-broken');
    const b = await submit('INV-slow');
    await run(broken, a);
    await checkOne({ store, chain, checker: slow, chainId: CHAIN_ID, checkerTimeoutMs: 50 }, b);
    for (const id of [a.id, b.id]) {
      const row = await store.get(id);
      expect(row?.status).toBe('held');
      expect(row?.reason).toBe('checker_unavailable');
    }
  });

  it('holds when the contract would not accept the checker signature after all', async () => {
    chain.rule = (_p, call) => (call.kind === 'pay' ? 'InvalidCheckerSignature' : undefined);
    const request = await submit('INV-badsig');
    await run(new TestChecker(checkerKey, CHAIN_ID), request);
    const row = await store.get(request.id);
    expect(row?.status).toBe('held');
    expect(row?.reason).toBe('checker_unavailable');
  });

  it('does nothing if another worker already took the request', async () => {
    const request = await submit('INV-taken');
    await store.transition(request.id, 'requested', 'checking');
    const checker = new TestChecker(checkerKey, CHAIN_ID);
    await run(checker, request);
    expect(checker.calls).toBe(0);
    expect((await store.get(request.id))?.status).toBe('checking');
  });
});
