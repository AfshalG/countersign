import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import type { Checker } from '../src/checker.js';
import type { RelayerPool } from '../src/relay/pool.js';
import { Workers } from '../src/workers.js';
import { requestId } from '../src/ids.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

/**
 * Slice 16: the workers keep every slot busy. A slow check must not hold up the payments claimed
 * alongside it (they used to wait for their whole batch).
 */
let database: Database;
let store: Store;
let workers: Workers | undefined;

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  workers?.stop();
  await database.pool.end();
});
beforeEach(async () => {
  workers?.stop();
  await truncate(database);
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
    deadline: 1_791_400_000,
    agentSig: AGENT_SIG,
  });
  return request.id;
}

describe('the check worker', () => {
  it('decides fast payments while a slow check is still running', async () => {
    const slow = await submit('INV-slow');
    // A moment later, so the slow one is claimed first.
    await new Promise((r) => setTimeout(r, 5));
    const fast = [];
    for (let i = 0; i < 6; i++) fast.push(await submit(`INV-fast-${String(i)}`));
    let release: () => void = () => undefined;
    const slowDone = new Promise<void>((r) => (release = r));
    const checker: Checker = {
      async check(input) {
        if (input.request.id === slow) await slowDone;
        return { verdict: 'hold', reason: 'amount_mismatch', evidence: { test: true } };
      },
    };
    workers = new Workers({
      store,
      chain: new FakeChain(),
      checker,
      pool: {} as RelayerPool, // nothing is released, so nothing is sent
      chainId: 10143,
      checkerTimeoutMs: 5_000,
      leaseMs: 30_000,
      checkConcurrency: 2,
      sendConcurrency: 2,
      tickMs: 5,
    });
    workers.start();
    const deadline = Date.now() + 2_000;
    let held = 0;
    while (Date.now() < deadline) {
      held = (await Promise.all(fast.map((id) => store.get(id)))).filter(
        (r) => r?.status === 'held',
      ).length;
      if (held === fast.length) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(held).toBe(fast.length);
    expect((await store.get(slow))?.status).toBe('checking');
    release();
  });
});
