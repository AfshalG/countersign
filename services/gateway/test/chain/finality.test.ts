import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { requestId } from '../../src/ids.js';
import { RelayerPool } from '../../src/relay/pool.js';
import { FinalityTracker, type Receipts } from '../../src/chain/finality.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeSender, SUPPLIER, VAULT, waitFor } from '../fakes.js';

let database: Database;
let store: Store;
let pool: RelayerPool;
let receipts: Map<number, { transactionHash: Hex; status: 'success' | 'reverted' }[]>;
let tracker: FinalityTracker;
let settled: string[];

const source: Receipts = {
  blockReceipts: (n) => Promise.resolve(receipts.get(n) ?? []),
  latestFinalized: () => Promise.resolve(Math.max(0, ...receipts.keys())),
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
  receipts = new Map();
  settled = [];
  pool = new RelayerPool({
    keys: [generatePrivateKey()],
    store,
    sender: new FakeSender(),
    chainId: 10143,
    endpoints: 3,
    stallMs: 5_000,
    tickMs: 10,
  });
  await pool.start();
  tracker = new FinalityTracker({
    store,
    receipts: source,
    pool,
    onChange: (id) => settled.push(id),
  });
});
afterEach(() => {
  pool.stop();
});

/** A request in `settling` with a transaction hash, as the send step leaves it. */
async function settling(invoice: string): Promise<{ id: string; hash: Hex }> {
  const invoiceHash = keccak256(toHex(invoice));
  const id = requestId(ACCOUNT, VAULT, invoiceHash);
  const hash = keccak256(toHex(`tx for ${invoice}`));
  await store.createRequest({
    id,
    account: ACCOUNT,
    vault: VAULT,
    invoiceHash,
    payTo: SUPPLIER,
    amount: 1_000n,
    deadline: 1_791_400_000,
    agentSig: AGENT_SIG,
  });
  await store.transition(id, 'requested', 'checking');
  await store.transition(id, 'checking', 'released', {
    checkerSig: AGENT_SIG,
    decidedBy: 'checker',
  });
  await store.transition(id, 'released', 'settling', { txHash: hash, sentAt: new Date() });
  return { id, hash };
}

const head = (number: number, blockId: string, commitState: string, at: number) => ({
  number,
  blockId,
  commitState,
  at,
});

describe('finality', () => {
  it('settles a payment only when its block is Finalized, with each stage time', async () => {
    const { id, hash } = await settling('INV-final');
    receipts.set(100, [{ transactionHash: hash, status: 'success' }]);
    await tracker.onHead(head(100, '0xb100', 'Proposed', 1_000));
    await tracker.onHead(head(100, '0xb100', 'Voted', 1_300));
    expect((await store.get(id))?.status).toBe('settling'); // proposed and voted are shown, never acted on
    await tracker.onHead(head(100, '0xb100', 'Finalized', 1_600));
    const row = await store.get(id);
    expect(row?.status).toBe('settled');
    expect(row?.blockNumber).toBe(100);
    expect(row?.proposedAt?.getTime()).toBe(1_000);
    expect(row?.votedAt?.getTime()).toBe(1_300);
    expect(row?.finalizedAt?.getTime()).toBe(1_600);
    expect(settled).toEqual([id]);
  });

  it('fails a payment whose transaction reverted, with the reason', async () => {
    const { id, hash } = await settling('INV-revert');
    receipts.set(200, [{ transactionHash: hash, status: 'reverted' }]);
    await tracker.onHead(head(200, '0xb200', 'Finalized', 5));
    const row = await store.get(id);
    expect(row?.status).toBe('failed');
    expect(row?.reason).toBe('reverted');
  });

  it('reads blocks it missed (a dropped socket) when a later block is finalized', async () => {
    const a = await settling('INV-a');
    const b = await settling('INV-b');
    receipts.set(300, [{ transactionHash: a.hash, status: 'success' }]);
    receipts.set(301, []);
    receipts.set(302, [{ transactionHash: b.hash, status: 'success' }]);
    await tracker.onHead(head(300, '0xb300', 'Finalized', 1));
    await tracker.onHead(head(302, '0xb302', 'Finalized', 3)); // 301 never arrived
    expect((await store.get(a.id))?.status).toBe('settled');
    expect((await store.get(b.id))?.status).toBe('settled');
  });

  it('ignores receipts that are not ours', async () => {
    const { id } = await settling('INV-mine');
    receipts.set(400, [{ transactionHash: keccak256(toHex('someone else')), status: 'success' }]);
    await tracker.onHead(head(400, '0xb400', 'Finalized', 1));
    expect((await store.get(id))?.status).toBe('settling');
  });

  it('polls the finalized tag when no heads arrive (the socket is down)', async () => {
    const { id, hash } = await settling('INV-poll');
    receipts.set(500, [{ transactionHash: hash, status: 'success' }]);
    await tracker.onHead(head(499, '0xb499', 'Finalized', 1));
    tracker.startPolling(20);
    await waitFor(async () => (await store.get(id))?.status === 'settled');
    tracker.stopPolling();
  });
});
