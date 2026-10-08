import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { NoRelayerFunds, RelayerPool, type Signed } from '../../src/relay/pool.js';
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
const address1 = privateKeyToAccount(key1).address;
/** 266,000 gas at the fake's 127.5 gwei maximum fee: what a wallet must hold to send one payment. */
const PAY_COST = 266_000n * 127_500_000_000n;

function newPool(poolKeys: Hex[], balanceRefreshMs?: number) {
  return new RelayerPool({
    keys: poolKeys,
    store,
    sender,
    chainId: 10143,
    endpoints: 3,
    stallMs: 150,
    tickMs: 20,
    ...(balanceRefreshMs === undefined ? {} : { balanceRefreshMs }),
  });
}
const payTx = { to: VAULT, data: '0x12345678' as Hex, gas: 266_000n };

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
    // Never stalls here: on a loaded CI machine a 150 ms stall can fire and re-send (correctly,
    // tested below), which is not what this test is about.
    pool.stop();
    pool = new RelayerPool({
      keys,
      store,
      sender,
      chainId: 10143,
      endpoints: 3,
      stallMs: 60_000,
      tickMs: 20,
    });
    await pool.start();
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

  it('moves a wallet whose oldest transaction keeps failing to send with a transient error (Slice 16)', async () => {
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
    // The wallet's endpoint answers every send with a transient error (rate limited, unreachable).
    const stuckOn = pool.lanesView()[0]?.endpoint;
    sender.reply = (endpoint) =>
      endpoint === stuckOn ? { error: 'HTTP 429 rate limited', retry: true } : 'accepted';
    const s = await pool.sign({ to: VAULT, data: '0x12345678', gas: 266_000n });
    pool.enqueue(s);
    await waitFor(() => sender.sent.some((x) => x.endpoint !== stuckOn && x.raw === s.raw), 3_000);
    expect(pool.moves().length).toBeGreaterThan(0);
    expect(pool.lanesView()[0]?.endpoint).not.toBe(stuckOn);
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

  it('never signs with a wallet that cannot cover the transaction’s maximum gas cost', async () => {
    pool.stop();
    sender.balances.set(address0.toLowerCase(), PAY_COST - 1n);
    pool = newPool(keys);
    await pool.start();
    for (let i = 0; i < 3; i++) expect((await pool.sign(payTx)).relayer).toBe(address1);
  });

  it('when loads are equal, signs with the wallet that has the most left', async () => {
    pool.stop();
    sender.balances.set(address0.toLowerCase(), 5n * PAY_COST);
    sender.balances.set(address1.toLowerCase(), 50n * PAY_COST);
    pool = newPool(keys);
    await pool.start();
    const s = await pool.sign(payTx);
    pool.enqueue(s);
    pool.included(s.hash);
    // Both wallets are idle again; the richer one is chosen, not the first in the list.
    expect((await pool.sign(payTx)).relayer).toBe(address1);
  });

  it('reserves each signed transaction’s cost, counts what was spent, and refuses when no wallet can pay', async () => {
    pool.stop();
    sender.balances.set(address0.toLowerCase(), 2n * PAY_COST);
    sender.balances.set(address1.toLowerCase(), 0n);
    pool = newPool(keys);
    await pool.start();
    const a = await pool.sign(payTx);
    const b = await pool.sign(payTx);
    expect([a.relayer, b.relayer]).toEqual([address0, address0]);
    await expect(pool.sign(payTx)).rejects.toBeInstanceOf(NoRelayerFunds);
    pool.enqueue(a);
    pool.included(a.hash); // its gas is spent, not returned
    await expect(pool.sign(payTx)).rejects.toBeInstanceOf(NoRelayerFunds);
    sender.balances.set(address1.toLowerCase(), 10n * PAY_COST); // topped up
    await pool.refreshBalances();
    expect((await pool.sign(payTx)).relayer).toBe(address1);
  });

  it('holds a transaction refused for low balance, then sends it again unchanged once the wallet is funded', async () => {
    pool.stop();
    let funded = false;
    sender.reply = () =>
      funded ? 'accepted' : { error: 'Signer had insufficient balance', retry: false };
    pool = newPool([key0], 100);
    await pool.start();
    const s = await pool.sign(payTx);
    sender.balances.set(address0.toLowerCase(), PAY_COST - 1n); // the chain now says it cannot pay
    pool.enqueue(s);
    await waitFor(() => sender.sent.length >= 1);
    await waitFor(() => pool.starved().includes(address0));
    await new Promise((r) => setTimeout(r, 250));
    expect(sender.sent).toHaveLength(1); // not hammered while the wallet is short
    funded = true;
    sender.balances.set(address0.toLowerCase(), 10n * PAY_COST);
    await waitFor(() => sender.sent.length >= 2, 2_000);
    expect(sender.sent[1]?.raw).toBe(s.raw); // the same nonce and hash: it can never pay twice
    expect(pool.starved()).toEqual([]);
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
