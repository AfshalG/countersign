import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { RelayerPool, type Signed } from '../../src/relay/pool.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { FakeSender, VAULT, waitFor } from '../fakes.js';

let database: Database;
let store: Store;
let sender: FakeSender;
let pool: RelayerPool;
const key0 = generatePrivateKey();
const key1 = generatePrivateKey();
const keys = [key0, key1];
const addresses = keys.map((k) => privateKeyToAccount(k).address);
const address0 = privateKeyToAccount(key0).address;

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  sender = new FakeSender();
  pool = new RelayerPool({
    keys,
    store,
    sender,
    chainId: 10143,
    endpoints: 3,
    stallMs: 150,
    tickMs: 20,
  });
  await pool.start();
});
afterEach(() => {
  pool.stop();
});

const nonceOf = (raw: Hex) => parseTransaction(raw).nonce;

describe('relayer pool', () => {
  it('signs with consecutive nonces per wallet and spreads work across wallets', async () => {
    const signed: Signed[] = [];
    for (let i = 0; i < 6; i++)
      signed.push(await pool.sign({ to: VAULT, data: '0x12345678', gas: 266_000n }));
    const byWallet = new Map<string, number[]>();
    for (const s of signed) byWallet.set(s.relayer, [...(byWallet.get(s.relayer) ?? []), s.nonce]);
    expect([...byWallet.keys()].sort()).toEqual([...addresses].sort());
    for (const nonces of byWallet.values()) expect(nonces).toEqual([0, 1, 2]);
    for (const s of signed) expect(nonceOf(s.raw)).toBe(s.nonce);
  });

  it('starts from the chain nonce', async () => {
    pool.stop();
    sender.chainNonces.set(address0.toLowerCase(), 41);
    pool = new RelayerPool({
      keys: [key0],
      store,
      sender,
      chainId: 10143,
      endpoints: 3,
      stallMs: 150,
      tickMs: 20,
    });
    await pool.start();
    expect((await pool.sign({ to: VAULT, data: '0x', gas: 21_000n })).nonce).toBe(41);
  });

  it('sends each wallet’s transactions in nonce order, through one endpoint', async () => {
    const signed: Signed[] = [];
    for (let i = 0; i < 6; i++) {
      const s = await pool.sign({ to: VAULT, data: '0x12345678', gas: 266_000n });
      pool.enqueue(s);
      signed.push(s);
    }
    await waitFor(() => sender.sent.length >= 6);
    for (const address of addresses) {
      const mine = sender.sent.filter(
        (x) =>
          parseTransaction(x.raw).to !== undefined &&
          signed.find((s) => s.raw === x.raw)?.relayer === address,
      );
      expect(mine.map((x) => nonceOf(x.raw))).toEqual([0, 1, 2]);
      expect(new Set(mine.map((x) => x.endpoint)).size).toBe(1);
    }
  });

  it('moves a stalled wallet to the next endpoint and re-sends its pending transactions in order', async () => {
    pool.stop();
    pool = new RelayerPool({
      keys: [key0],
      store,
      sender,
      chainId: 10143,
      endpoints: 3,
      stallMs: 150,
      tickMs: 20,
    });
    await pool.start();
    sender.blackHoles.add(0); // the wallet's first endpoint accepts and drops everything
    const a = await pool.sign({ to: VAULT, data: '0x', gas: 21_000n });
    const b = await pool.sign({ to: VAULT, data: '0x', gas: 21_000n });
    pool.enqueue(a);
    pool.enqueue(b);
    await waitFor(() => sender.sent.filter((x) => x.endpoint !== 0).length >= 2, 2_000);
    const moved = sender.sent.filter((x) => x.endpoint !== 0);
    expect(moved.map((x) => nonceOf(x.raw))).toEqual([0, 1]);
    expect(pool.moves()).toHaveLength(1);
  });

  it('stops re-sending a transaction once it is in a finalized block', async () => {
    const s = await pool.sign({ to: VAULT, data: '0x', gas: 21_000n });
    pool.enqueue(s);
    await waitFor(() => sender.sent.length >= 1);
    pool.included(s.hash);
    await new Promise((r) => setTimeout(r, 300));
    expect(sender.sent.filter((x) => x.raw === s.raw)).toHaveLength(1);
    expect(pool.pending()).toBe(0);
  });

  it('treats "already known" as accepted, and retries a transient failure', async () => {
    let calls = 0;
    sender.reply = () => (++calls === 1 ? { error: 'HTTP 429', retry: true } : 'known');
    const s = await pool.sign({ to: VAULT, data: '0x', gas: 21_000n });
    pool.enqueue(s);
    await waitFor(() => calls >= 2);
    expect(pool.accepted(s.hash)).toBe(true);
  });
});
