import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, parseTransaction, toHex, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { orderVaultAbi, GAS_LIMITS, ownerGas } from '@countersign/chain';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { requestId } from '../../src/ids.js';
import { RelayerPool } from '../../src/relay/pool.js';
import { sendOne } from '../../src/pipeline/send.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, FakeSender, SUPPLIER, VAULT, waitFor } from '../fakes.js';

let database: Database;
let store: Store;
let chain: FakeChain;
let sender: FakeSender;
let pool: RelayerPool;
const CHECKER_SIG: Hex = `0x${'cd'.repeat(65)}`;

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
  chain.rule = () => undefined; // released payments: the contract accepts them
  sender = new FakeSender();
  pool = new RelayerPool({
    keys: [generatePrivateKey()],
    store,
    sender,
    chainId: 10143,
    endpoints: 3,
    stallMs: 5_000,
    tickMs: 10,
  });
  await pool.start();
});
afterEach(() => {
  pool.stop();
});

/** One stored owner assertion (JSON: bigints as strings). */
const stored = {
  r: `0x${'11'.repeat(32)}`,
  s: `0x${'22'.repeat(32)}`,
  challengeIndex: '23',
  typeIndex: '1',
  authenticatorData: `0x${'33'.repeat(37)}`,
  clientDataJSON: '{"type":"webauthn.get"}',
};

async function released(invoice: string, how: 'checker' | 'owner' = 'checker') {
  const invoiceHash = keccak256(toHex(invoice));
  const id = requestId(ACCOUNT, VAULT, invoiceHash);
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
  if (how === 'checker')
    await store.transition(id, 'checking', 'released', {
      checkerSig: CHECKER_SIG,
      decidedBy: 'checker',
    });
  else {
    await store.transition(id, 'checking', 'held', {
      reason: 'items_mismatch',
      decidedBy: 'checker',
    });
    const ownerAuth = {
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
      challengeIndex: '23',
      typeIndex: '1',
      authenticatorData: `0x${'33'.repeat(37)}`,
      clientDataJSON: '{"type":"webauthn.get"}',
    };
    await store.transition(id, 'held', 'released', { ownerAuth, decidedBy: 'user_once' });
  }
  const row = await store.get(id);
  if (!row) throw new Error('missing');
  return row;
}

const deps = () => ({ store, chain, pool });

describe('the send step', () => {
  it('signs pay(payment, agentSig, checkerSig) to the vault, stores it, and sends it', async () => {
    const row = await released('INV-send');
    await sendOne(deps(), row);
    const after = await store.get(row.id);
    expect(after?.status).toBe('settling');
    expect(after?.relayerNonce).toBe(0);
    expect(after?.txHash).toBe(keccak256(after?.rawTx as Hex));
    expect(after?.sentAt).toBeInstanceOf(Date);
    const tx = parseTransaction(after?.rawTx as Hex);
    expect(tx.to?.toLowerCase()).toBe(VAULT.toLowerCase());
    expect(tx.gas).toBe(GAS_LIMITS.pay);
    const call = decodeFunctionData({ abi: orderVaultAbi, data: tx.data as Hex });
    expect(call.functionName).toBe('pay');
    expect(call.args[1]).toBe(AGENT_SIG);
    expect(call.args[2]).toBe(CHECKER_SIG);
    await waitFor(() => sender.sent.some((s) => s.raw === after?.rawTx));
  });

  it('pays a held payment the owner approved with payWithOwner', async () => {
    const row = await released('INV-owner', 'owner');
    await sendOne(deps(), row);
    const after = await store.get(row.id);
    const call = decodeFunctionData({
      abi: orderVaultAbi,
      data: parseTransaction(after?.rawTx as Hex).data as Hex,
    });
    expect(call.functionName).toBe('payWithOwner');
    expect(parseTransaction(after?.rawTx as Hex).gas).toBe(GAS_LIMITS.payWithOwner);
  });

  it('gives a pay-once the gas for every owner who signed it (D36)', async () => {
    const row = await released('INV-two-owners', 'owner');
    await store.update(row.id, 'released', {
      ownerAuth: [
        { owner: 0, auth: stored },
        { owner: 1, auth: stored },
      ],
    });
    const two = await store.get(row.id);
    if (!two) throw new Error('missing');
    await sendOne(deps(), two);
    const tx = parseTransaction((await store.get(row.id))?.rawTx as Hex);
    const call = decodeFunctionData({ abi: orderVaultAbi, data: tx.data as Hex });
    expect((call.args[1] as readonly { owner: number }[]).map((x) => x.owner)).toEqual([0, 1]);
    expect(tx.gas).toBe(ownerGas('payWithOwner', 2));
  });

  it('fails a payment the chain would now refuse, without using a nonce', async () => {
    chain.rule = () => 'VaultClosed';
    const row = await released('INV-closed');
    await sendOne(deps(), row);
    const after = await store.get(row.id);
    expect(after?.status).toBe('failed');
    expect(after?.reason).toBe('order_closed');
    expect(after?.rawTx).toBeNull();
    chain.rule = () => undefined;
    const next = await released('INV-next');
    await sendOne(deps(), next);
    expect((await store.get(next.id))?.relayerNonce).toBe(0);
  });

  it('re-sends a transaction signed before a crash instead of signing a second one', async () => {
    const row = await released('INV-crash');
    const signed = await pool.sign({ to: VAULT, data: '0x', gas: 21_000n }, row.id); // signed and stored, then "crashed"
    const stored = await store.get(row.id);
    if (!stored) throw new Error('missing');
    await sendOne(deps(), stored);
    const after = await store.get(row.id);
    expect(after?.status).toBe('settling');
    expect(after?.rawTx).toBe(signed.raw);
    await waitFor(() => sender.sent.some((s) => s.raw === signed.raw));
    expect(sender.sent.filter((s) => s.raw !== signed.raw)).toHaveLength(0);
  });
});

describe('the send step at volume (Slice 16: one chain read fewer per payment)', () => {
  /** An order on file for the vault, holding `amount` base units. */
  const order = (amount: string) =>
    store.upsertOrder({
      vault: VAULT,
      account: ACCOUNT,
      orderId: keccak256(toHex('order at volume')),
      supplierId: keccak256(toHex('kalibre-studio')),
      orderHash: keccak256(toHex('quote')),
      amount,
      expiry: Math.floor(Date.now() / 1000) + 86_400,
      approvedBlock: 1,
    });
  /** Released by the checker `msAgo` milliseconds ago. */
  const fresh = async (invoice: string, msAgo = 0) => {
    const row = await released(invoice);
    await store.update(row.id, 'released', { checkedAt: new Date(Date.now() - msAgo) });
    const after = await store.get(row.id);
    if (!after) throw new Error('missing');
    return after;
  };

  it('sends a payment checked moments ago without simulating it again, when its order has room', async () => {
    await order('30000');
    const row = await fresh('INV-fresh');
    const before = chain.simulations;
    await sendOne(deps(), row);
    expect(chain.simulations).toBe(before);
    expect((await store.get(row.id))?.status).toBe('settling');
  });

  it('simulates when the check is old, or the order has no room left by the gateway’s count', async () => {
    await order('1500');
    const old = await fresh('INV-old', 60_000);
    let before = chain.simulations;
    await sendOne(deps(), old);
    expect(chain.simulations).toBe(before + 1); // checked a minute ago: looked at again
    // 1,000 of the 1,500 is now sent; another 1,000 would not fit, so the chain decides.
    const over = await fresh('INV-over');
    before = chain.simulations;
    await sendOne(deps(), over);
    expect(chain.simulations).toBe(before + 1);
  });

  it('sends to one order one at a time, so payments sent together never overrun it', async () => {
    await order('2500');
    const rows = [await fresh('INV-a'), await fresh('INV-b'), await fresh('INV-c')];
    const before = chain.simulations;
    await Promise.all(rows.map((r) => sendOne(deps(), r)));
    // Two fit the order by the gateway's own count; the third is left to the chain.
    expect(chain.simulations).toBe(before + 1);
  });

  it('always simulates an owner’s pay-once', async () => {
    await order('30000');
    const row = await released('INV-owner-fresh', 'owner');
    await store.update(row.id, 'released', { checkedAt: new Date() });
    const again = await store.get(row.id);
    if (!again) throw new Error('missing');
    const before = chain.simulations;
    await sendOne(deps(), again);
    expect(chain.simulations).toBe(before + 1);
  });
});
