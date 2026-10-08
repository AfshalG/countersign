import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { requestId, runId } from '../src/ids.js';
import { RelayerPool } from '../src/relay/pool.js';
import { FinalityTracker } from '../src/chain/finality.js';
import { TestChecker } from '../src/checker.js';
import { Workers } from '../src/workers.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, SUPPLIER, VAULT, waitFor } from './fakes.js';
import { FakeMonad } from './fake-monad.js';

let database: Database;
let store: Store;
let monad: FakeMonad;
const relayerKeys = [
  generatePrivateKey(),
  generatePrivateKey(),
  generatePrivateKey(),
  generatePrivateKey(),
];
const checkerKey = generatePrivateKey();
const CHAIN_ID = 10143;
const running: { stop: () => void }[] = [];

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
});
afterEach(() => {
  for (const r of running.splice(0)) r.stop();
  monad.stop();
});

/** One gateway process: pool, finality tracker and workers, wired as main.ts wires them. */
async function startGateway() {
  const pool = new RelayerPool({
    keys: relayerKeys,
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
    checker: new TestChecker(checkerKey, CHAIN_ID),
    pool,
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    leaseMs: 400,
    checkConcurrency: 16,
    sendConcurrency: 8,
    tickMs: 10,
  });
  await pool.start();
  await workers.recover();
  workers.start();
  running.push(workers, pool);
  return { pool, workers };
}

async function submitRun(n: number): Promise<string[]> {
  const ids: Hex[] = [];
  const invoices = Array.from({ length: n }, (_, i) =>
    keccak256(toHex(`run invoice ${String(i)}`)),
  );
  for (const invoiceHash of invoices) ids.push(requestId(ACCOUNT, VAULT, invoiceHash));
  const run = runId(ACCOUNT, ids);
  await store.createRun(run, ACCOUNT, n);
  for (const [i, invoiceHash] of invoices.entries()) {
    await store.createRequest({
      id: ids[i] as Hex,
      runId: run,
      account: ACCOUNT,
      vault: VAULT,
      invoiceHash,
      payTo: SUPPLIER,
      amount: 1_000n,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      agentSig: AGENT_SIG,
    });
  }
  return ids;
}

const statuses = async (ids: readonly string[]) =>
  Promise.all(ids.map(async (id) => (await store.get(id))?.status));

describe('end to end, against a small fake Monad', () => {
  it('a run of 200 reaches 200 final statuses: every invoice paid exactly once', async () => {
    const ids = await submitRun(200);
    monad.start(20);
    await startGateway();
    await waitFor(async () => (await statuses(ids)).every((s) => s === 'settled'), 30_000);
    expect(monad.paid.size).toBe(200);
    expect([...monad.paid.values()].every((n) => n === 1)).toBe(true);
    const rows = await Promise.all(ids.map((id) => store.get(id)));
    expect(rows.every((r) => r?.finalizedAt instanceof Date && r.blockNumber !== null)).toBe(true);
  }, 40_000);

  it('a crash mid-run recovers: every request still ends in one final status, no invoice paid twice', async () => {
    const ids = await submitRun(200);
    monad.start(20);
    const first = await startGateway();
    await waitFor(
      async () => (await statuses(ids)).filter((s) => s === 'settled').length >= 40,
      20_000,
    );
    first.workers.stop(); // the process dies: in-memory lanes, claims and its finality tracker are gone
    first.pool.stop();
    monad.onHead = () => undefined;
    // Blocks keep finalizing while it is down, so some payments land with nobody recording them,
    // and the leases the dead process held run out.
    await new Promise((r) => setTimeout(r, 500));
    await startGateway(); // a new process starts and recovers from the database alone
    await waitFor(async () => (await statuses(ids)).every((s) => s === 'settled'), 30_000);
    expect(monad.paid.size).toBe(200);
    expect([...monad.paid.values()].every((n) => n === 1)).toBe(true);
  }, 60_000);

  it('a transaction that is not a payment, signed just before a crash, is sent after the restart: no relayer is left stuck behind its nonce', async () => {
    monad.start(20);
    const first = await startGateway();
    // Judge-mode setup reserves a relayer nonce for every relayer; the process dies before sending.
    const setup: Hex[] = [];
    for (let i = 0; i < relayerKeys.length; i++) {
      const signed = await first.pool.sign(
        { to: ACCOUNT, data: '0x12345678', gas: 100_000n },
        { purpose: `demo setup ${String(i)}` },
      );
      setup.push(signed.hash);
    }
    first.workers.stop();
    first.pool.stop();
    monad.onHead = () => undefined;
    expect(await store.pendingRelayerTxs()).toHaveLength(relayerKeys.length);

    await startGateway(); // recovers from the database alone
    const ids = await submitRun(40); // enough to give every relayer work
    await waitFor(async () => (await statuses(ids)).every((s) => s === 'settled'), 30_000);
    for (const hash of setup)
      expect(await monad.finalizedReceipt(hash)).toMatchObject({ status: 'success' });
    await waitFor(async () => (await store.pendingRelayerTxs()).length === 0, 5_000);
  }, 60_000);
});
