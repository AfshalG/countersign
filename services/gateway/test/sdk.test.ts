import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, type Address } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Countersign, type StatusChange } from '@countersign/sdk';
import { supplierId } from '@countersign/shared';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { RelayerPool } from '../src/relay/pool.js';
import { FinalityTracker } from '../src/chain/finality.js';
import { TestChecker } from '../src/checker.js';
import { Workers } from '../src/workers.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, SUPPLIER, VAULT } from './fakes.js';
import { FakeMonad } from './fake-monad.js';

/**
 * The SDK against the real gateway: the app, the check and send workers, the relayer pool and
 * the finality tracker, on the fake chain (Slice 6's e2e wiring). What a developer's agent does
 * with `@countersign/sdk`, end to end.
 */
let database: Database;
let store: Store;
let monad: FakeMonad;
let cs: Countersign;
const TOKEN = 'sdk-test-service-token-0123456789';
const CHAIN_ID = 10143;
const running: { stop: () => void }[] = [];
const LOOK_ALIKE: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEd';

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  monad = new FakeMonad();
  const checker = new TestChecker(generatePrivateKey(), CHAIN_ID);
  const pool = new RelayerPool({
    keys: [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()],
    store,
    sender: monad,
    chainId: CHAIN_ID,
    endpoints: 3,
    stallMs: 2_000,
    tickMs: 5,
  });
  const tracker = new FinalityTracker({ store, receipts: monad, pool });
  monad.onHead = (head) => {
    void tracker.onHead(head);
  };
  const workers = new Workers({
    store,
    chain: monad,
    checker,
    pool,
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    leaseMs: 400,
    checkConcurrency: 8,
    sendConcurrency: 8,
    tickMs: 10,
  });
  await pool.start();
  workers.start();
  monad.start(20);
  running.push(workers, pool);
  const app = createApp({
    store,
    chain: monad,
    checker,
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: 'https://gateway.test',
    indexing: { latestFinalized: () => Promise.resolve(1_000), catchUp: () => Promise.resolve() },
    health: () => Promise.resolve({}),
  });
  cs = new Countersign({
    gateway: 'https://gateway.test',
    token: TOKEN,
    account: ACCOUNT,
    agentKey: generatePrivateKey(),
    fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
  });
  await store.registerAccount(ACCOUNT, 900);
  await store.upsertOrder({
    vault: VAULT,
    account: ACCOUNT,
    orderId: keccak256(toHex('order 1')),
    supplierId: supplierId('kalibre-studio'),
    orderHash: keccak256(toHex('order 1 PDF')),
    amount: '30000',
    expiry: Math.floor(Date.now() / 1000) + 86_400,
    approvedBlock: 950,
  });
});
afterEach(() => {
  for (const r of running.splice(0)) r.stop();
  monad.stop();
});

const wait = { timeoutMs: 10_000, pollMs: 20 };

describe('the SDK against the gateway', () => {
  it('lists the open order and pays an invoice: settled at Finalized', async () => {
    const [order] = await cs.orders();
    expect(order).toMatchObject({ vault: VAULT, payTo: SUPPLIER, remaining: '30000' });
    if (!order) throw new Error('no order');
    const result = await cs.pay({
      order,
      invoice: { number: 'INV-0042', amount: '0.001', payTo: SUPPLIER },
      wait,
    });
    expect(result.status).toBe('settled');
    expect(result.tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.statusUrl).toBe(`https://gateway.test/p/${result.id}`);
  });

  it('pays the same invoice once, however often it is sent (and however it is typed)', async () => {
    const order = keccak256(toHex('order 1'));
    const first = await cs.pay({
      order,
      invoice: { number: 'INV-0050', amount: '0.001', payTo: SUPPLIER },
      wait,
    });
    const again = await cs.pay({
      order,
      invoice: { number: ' inv 0050 '.replace(' 0', '-0'), amount: '0.001', payTo: SUPPLIER },
      wait,
    });
    expect(again.id).toBe(first.id);
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect([...monad.paid.values()]).toEqual([1]);
  });

  it('holds a look-alike address, with both addresses and the reason in plain words', async () => {
    const result = await cs.pay({
      order: keccak256(toHex('order 1')),
      invoice: { number: 'INV-0045', amount: '0.001', payTo: LOOK_ALIKE },
      wait,
    });
    expect(result.status).toBe('held');
    expect(result.reason).toBe('address_mismatch');
    expect(result.reasonText).toBe(
      "The invoice's payment address is not the supplier's address on file.",
    );
    expect(result.evidence).toMatchObject({
      payTo: { onFile: getAddress(SUPPLIER), invoice: getAddress(LOOK_ALIKE) },
    });
    expect(monad.paid.size).toBe(0);
  });

  it('checks without paying', async () => {
    const verdict = await cs.check({
      order: keccak256(toHex('order 1')),
      invoice: { number: 'INV-0060', amount: '0.001', payTo: SUPPLIER },
    });
    expect(verdict).toMatchObject({ verdict: 'would_settle', reason: null });
    expect(monad.paid.size).toBe(0);
  });

  it('pays a run of 5 and streams every change to settled', { timeout: 15_000 }, async () => {
    const controller = new AbortController();
    const changes: StatusChange[] = [];
    const run = await cs.payMany(
      Array.from({ length: 5 }, (_, i) => ({
        order: keccak256(toHex('order 1')),
        invoice: { number: `RUN-${String(i)}`, amount: '0.001', payTo: SUPPLIER },
      })),
    );
    const watching = (async () => {
      for await (const change of cs.watch({ runId: run.runId, signal: controller.signal })) {
        changes.push(change);
        if (changes.filter((c) => c.to === 'settled').length === 5) controller.abort();
      }
    })();
    const deadline = Date.now() + 10_000;
    while ((await cs.run(run.runId)).byStatus.settled < 5 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await watching;
    expect((await cs.run(run.runId)).byStatus.settled).toBe(5);
    expect(changes.every((c) => c.runId === run.runId)).toBe(true);
    expect(changes.some((c) => c.to === 'settled')).toBe(true);
  });

  it('proposes a supplier and an order: a link, nothing changed', async () => {
    const proposal = await cs.proposeOrder({
      supplier: { name: 'Kalibre Studio', website: 'https://kalibre.example', payTo: SUPPLIER },
      amount: '4200',
      expiry: new Date(Date.now() + 30 * 86_400_000),
      document: 'Quote Q-2026-001: brand identity, 4,200.00 USDC',
    });
    expect(proposal.status).toBe('pending');
    expect(proposal.approvalUrl).toBe(`https://gateway.test/p/${proposal.id}`);
    expect((await cs.proposal(proposal.id)).id).toBe(proposal.id);
  });
});
