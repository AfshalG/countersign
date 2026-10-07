import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, parseTransaction, toHex, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { orderVaultAbi, GAS_LIMITS } from '@countersign/chain';
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
