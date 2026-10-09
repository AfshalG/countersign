import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { countersignAccountAbi } from '@countersign/chain';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { OrderIndexer, type LogSource, type RawLog } from '../../src/chain/indexer.js';
import { freshDatabase, truncate } from '../db/helpers.js';

const ACCOUNT: Address = '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603';
const STRANGER: Address = '0x1111111111111111111111111111111111111111';
const VAULT_A: Address = '0x771d1b283D9Bf9A6e14bAdF0c9C4d1BE05D87dC7';
const VAULT_B: Address = '0xbd19BbE40044a3175A3213D8408a434b882CADF4';
const SUPPLIER = keccak256(toHex('kalibre-studio'));
const NOW = Math.floor(Date.now() / 1000);

function approved(
  account: Address,
  vault: Address,
  order: string,
  block: number,
  expiry = NOW + 86_400,
): RawLog {
  return {
    address: account,
    topics: encodeEventTopics({
      abi: countersignAccountAbi,
      eventName: 'OrderApproved',
      args: { orderId: keccak256(toHex(order)), supplierId: SUPPLIER },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
      [vault, keccak256(toHex(`${order} PDF`)), 30_000n, BigInt(expiry)],
    ),
    blockNumber: block,
  };
}
function closed(account: Address, vault: Address, order: string, block: number): RawLog {
  return {
    address: account,
    topics: encodeEventTopics({
      abi: countersignAccountAbi,
      eventName: 'OrderClosed',
      args: { orderId: keccak256(toHex(order)) },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [vault, 0n]),
    blockNumber: block,
  };
}

class FakeLogs implements LogSource {
  logs_: RawLog[] = [];
  head = 1_000;
  calls: { from: number; to: number }[] = [];
  logs(addresses: Address[], from: number, to: number): Promise<RawLog[]> {
    this.calls.push({ from, to });
    const set = new Set(addresses.map((a) => a.toLowerCase()));
    return Promise.resolve(
      this.logs_.filter(
        (l) => set.has(l.address.toLowerCase()) && l.blockNumber >= from && l.blockNumber <= to,
      ),
    );
  }
  latestFinalized(): Promise<number> {
    return Promise.resolve(this.head);
  }
}

let database: Database;
let store: Store;
let source: FakeLogs;
let indexer: OrderIndexer;

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  source = new FakeLogs();
  indexer = new OrderIndexer({ store, source, windowBlocks: 100 });
});

describe('the order indexer', () => {
  it('adds an order from a finalized OrderApproved and closes it on OrderClosed', async () => {
    await store.registerAccount(ACCOUNT, 500);
    source.head = 499;
    await indexer.catchUp(); // nothing to do yet: the account starts at 500
    await indexer.onBlock(500, [approved(ACCOUNT, VAULT_A, 'order 1', 500)]);
    let open = await store.openOrders(ACCOUNT, NOW);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      vault: VAULT_A,
      supplierId: SUPPLIER,
      amount: '30000',
      approvedBlock: 500,
    });
    await indexer.onBlock(501, [closed(ACCOUNT, VAULT_A, 'order 1', 501)]);
    open = await store.openOrders(ACCOUNT, NOW);
    expect(open).toHaveLength(0);
  });

  it('ignores other accounts, other events and expired orders', async () => {
    await store.registerAccount(ACCOUNT, 600);
    const unrelated: RawLog = {
      address: ACCOUNT,
      topics: [keccak256(toHex('Other(uint256)'))],
      data: '0x',
      blockNumber: 600,
    };
    await indexer.onBlock(600, [
      approved(STRANGER, VAULT_B, 'not ours', 600),
      unrelated,
      approved(ACCOUNT, VAULT_B, 'expired', 600, NOW - 1),
    ]);
    expect(await store.openOrders(ACCOUNT, NOW)).toHaveLength(0);
    expect(await store.openOrders(STRANGER, NOW)).toHaveLength(0);
  });

  it('catches up from its saved block in windows after a restart, applying each event once', async () => {
    await store.registerAccount(ACCOUNT, 100);
    source.head = 450;
    source.logs_ = [
      approved(ACCOUNT, VAULT_A, 'order 1', 120),
      approved(ACCOUNT, VAULT_B, 'order 2', 390),
      closed(ACCOUNT, VAULT_A, 'order 1', 400),
    ];
    await indexer.catchUp();
    expect(source.calls).toEqual([
      { from: 100, to: 199 },
      { from: 200, to: 299 },
      { from: 300, to: 399 },
      { from: 400, to: 450 },
    ]);
    expect((await store.openOrders(ACCOUNT, NOW)).map((o) => o.vault)).toEqual([VAULT_B]);
    expect((await store.listAccounts())[0]?.indexedTo).toBe(450);
    // A restart replays nothing new, and replaying the same logs changes nothing.
    source.calls = [];
    await indexer.catchUp();
    expect(source.calls).toEqual([]);
    await indexer.onBlock(400, [closed(ACCOUNT, VAULT_A, 'order 1', 400)]);
    expect((await store.openOrders(ACCOUNT, NOW)).map((o) => o.vault)).toEqual([VAULT_B]);
  });

  it('keeps every caught-up account up to date in one write per block, however many there are (Slice 16)', async () => {
    const others = Array.from(
      { length: 40 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as const,
    );
    // Registered from block 800: indexed up to 799, so block 800 is next for each.
    for (const a of others) await store.registerAccount(a, 800);
    await store.registerAccount(ACCOUNT, 800);
    let writes = 0;
    const counting = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === 'setIndexedTo' || prop === 'advanceIndexed') {
          return (...args: unknown[]) => {
            writes++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const fast = new OrderIndexer({ store: counting, source, windowBlocks: 100 });
    await fast.onBlock(800, [approved(ACCOUNT, VAULT_A, 'in a busy block', 800)]);
    expect(writes).toBe(1);
    expect(await store.openOrders(ACCOUNT, NOW)).toHaveLength(1);
    expect((await store.listAccounts()).every((a) => a.indexedTo === 800)).toBe(true);
  });

  it('leaves an account that is behind to the catch-up, never skipping a gap', async () => {
    await store.registerAccount(ACCOUNT, 700);
    await indexer.onBlock(705, [approved(ACCOUNT, VAULT_A, 'after a gap', 705)]); // 700–704 unseen
    expect(await store.openOrders(ACCOUNT, NOW)).toHaveLength(0);
    expect((await store.listAccounts())[0]?.indexedTo).toBe(699);
    source.head = 705;
    source.logs_ = [approved(ACCOUNT, VAULT_A, 'after a gap', 705)];
    await indexer.catchUp();
    expect(await store.openOrders(ACCOUNT, NOW)).toHaveLength(1);
  });
});
