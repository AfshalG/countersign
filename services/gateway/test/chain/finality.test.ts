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

  it('keeps up with a backlog: reads the next blocks’ receipts while one is applied, in order (Slice 16)', async () => {
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(await settling(`INV-backlog-${String(i)}`));
    rows.forEach((r, i) => receipts.set(400 + i, [{ transactionHash: r.hash, status: 'success' }]));
    let inFlight = 0;
    let most = 0;
    const slow: Receipts = {
      blockReceipts: async (n) => {
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return receipts.get(n) ?? [];
      },
      latestFinalized: () => Promise.resolve(405),
    };
    const order: string[] = [];
    const backlog = new FinalityTracker({
      store,
      receipts: slow,
      pool,
      onChange: (id) => order.push(id),
    });
    await backlog.onHead(head(399, '0xb399', 'Finalized', 1));
    await backlog.onHead(head(405, '0xb405', 'Finalized', 2));
    expect(most).toBeGreaterThan(1); // receipts read ahead
    expect(order).toEqual(rows.map((r) => r.id)); // applied in block order
  });

  it('marks every payment in a busy block (Slice 16: they are written together)', async () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(await settling(`INV-busy-${String(i)}`));
    receipts.set(
      500,
      rows.map((r) => ({ transactionHash: r.hash, status: 'success' as const })),
    );
    await tracker.onHead(head(500, '0xb500', 'Finalized', 1));
    const after = await Promise.all(rows.map((r) => store.get(r.id)));
    expect(after.every((r) => r?.status === 'settled')).toBe(true);
    expect(settled).toHaveLength(20);
  });

  it('tells whoever waits on a transaction that is not a payment once it is final (judge setup)', async () => {
    const hash = keccak256(toHex('createAccount for a judge'));
    let included: Hex | undefined;
    const watched = new FinalityTracker({
      store,
      receipts: source,
      pool: { included: (h: Hex) => (included = h) },
    });
    const waiting = watched.waitFinal(hash, 5_000);
    receipts.set(500, [{ transactionHash: hash, status: 'success' }]);
    await watched.onHead(head(500, '0xb500', 'Voted', 1)); // not final yet: still waiting
    await watched.onHead(head(500, '0xb500', 'Finalized', 2));
    await expect(waiting).resolves.toEqual({ status: 'success', blockNumber: 500 });
    expect(included).toBe(hash); // its relayer lane stops tracking it
  });

  it('gives up waiting after the timeout, without losing the transaction', async () => {
    const hash = keccak256(toHex('never mined'));
    await expect(tracker.waitFinal(hash, 50)).rejects.toThrow(/not final/);
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
