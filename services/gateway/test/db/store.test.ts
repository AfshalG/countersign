import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { requestId } from '../../src/ids.js';
import { Store, type NewRequest } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { freshDatabase, truncate } from './helpers.js';

let database: Database;
let store: Store;

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
});

const account = '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603';
const vault = '0xbd19BbE40044a3175A3213D8408a434b882CADF4';

function newRequest(invoice: string): NewRequest {
  const invoiceHash = keccak256(toHex(invoice));
  return {
    id: requestId(account, vault, invoiceHash),
    account,
    vault,
    invoiceHash,
    payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEc',
    amount: 1_000n,
    deadline: 1_791_400_000,
    agentSig: `0x${'ab'.repeat(65)}`,
  };
}

describe('creating requests', () => {
  it('creates a request once; the same invoice again returns the first', async () => {
    const first = await store.createRequest(newRequest('INV-1'));
    expect(first.created).toBe(true);
    expect(first.request.status).toBe('requested');
    const again = await store.createRequest(newRequest('INV-1'));
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(first.request.id);
    expect(await store.events(first.request.id)).toHaveLength(1);
  });

  it('keeps the amount exact as a uint256', async () => {
    const big = { ...newRequest('INV-big'), amount: 2n ** 200n + 7n };
    const { request } = await store.createRequest(big);
    expect(BigInt(request.amount)).toBe(2n ** 200n + 7n);
  });
});

describe('status changes', () => {
  it('moves along an allowed path and records each step', async () => {
    const { request } = await store.createRequest(newRequest('INV-2'));
    expect(await store.transition(request.id, 'requested', 'checking')).toBe(true);
    expect(
      await store.transition(request.id, 'checking', 'held', {
        reason: 'address_mismatch',
        decidedBy: 'rule',
      }),
    ).toBe(true);
    const row = await store.get(request.id);
    expect(row?.status).toBe('held');
    expect(row?.reason).toBe('address_mismatch');
    const events = await store.events(request.id);
    expect(events.map((e) => e.toStatus)).toEqual(['requested', 'checking', 'held']);
  });

  it('refuses a path the state machine does not allow', async () => {
    const { request } = await store.createRequest(newRequest('INV-3'));
    await expect(store.transition(request.id, 'requested', 'settled')).rejects.toThrow(
      /not allowed/,
    );
  });

  it('loses cleanly when another worker moved the request first', async () => {
    const { request } = await store.createRequest(newRequest('INV-4'));
    await store.transition(request.id, 'requested', 'checking');
    expect(await store.transition(request.id, 'requested', 'checking')).toBe(false);
    expect(await store.events(request.id)).toHaveLength(2);
  });

  it('never leaves a final status', async () => {
    const { request } = await store.createRequest(newRequest('INV-5'));
    await store.transition(request.id, 'requested', 'blocked', {
      reason: 'over_limit',
      decidedBy: 'rule',
    });
    await expect(store.transition(request.id, 'blocked', 'checking')).rejects.toThrow(
      /not allowed/,
    );
  });
});

describe('claiming work', () => {
  it('two workers claiming at once never get the same request', async () => {
    for (let i = 0; i < 8; i++) await store.createRequest(newRequest(`INV-claim-${String(i)}`));
    const [a, b] = await Promise.all([
      store.claim('requested', 5, 30_000),
      store.claim('requested', 5, 30_000),
    ]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(8);
  });

  it('does not hand out a request again while its lease runs, and does after', async () => {
    await store.createRequest(newRequest('INV-lease'));
    expect(await store.claim('requested', 10, 60_000)).toHaveLength(1);
    expect(await store.claim('requested', 10, 60_000)).toHaveLength(0);
    const [only] = await store.claim('requested', 10, 60_000, new Date(Date.now() + 61_000));
    expect(only?.id).toBeDefined();
  });
});

describe('relayer nonces', () => {
  it('hands out consecutive nonces under concurrency, starting from the chain count', async () => {
    const relayer = '0x41477b603E26Ba7336380D9885Ef96C507b71691';
    const got = await Promise.all(
      Array.from({ length: 10 }, () => store.reserveNonce(relayer, 60)),
    );
    expect([...got].sort((x, y) => x - y)).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
  });

  it('never goes below the chain count after a restart', async () => {
    const relayer = '0x4bA5922256FBF0432064aE3E1d3770E2f9A84E3D';
    expect(await store.reserveNonce(relayer, 5)).toBe(5);
    expect(await store.reserveNonce(relayer, 9)).toBe(9); // the chain moved on: resume from there
    expect(await store.reserveNonce(relayer, 0)).toBe(10);
  });
});
