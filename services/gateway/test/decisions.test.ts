import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import { orderVaultAbi } from '@countersign/chain';
import { OUTCOME, evidenceHash, reasonHash } from '@countersign/shared';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { relayerTxs } from '../src/db/schema.js';
import { DecisionRecorder } from '../src/decisions.js';
import type { Signed } from '../src/relay/pool.js';
import type { OwnerSig } from '../src/chain/types.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, SUPPLIER, VAULT } from './fakes.js';

/**
 * Slice 18: each checker hold and owner refusal is written on Monad with its evidence hash, through
 * the relayer pool, once; after a restart, what was never signed is sent and nothing twice.
 */
let database: Database;
let store: Store;

class FakePool {
  signed: { to: Address; data: Hex; gas: bigint; purpose: string }[] = [];
  queued: Signed[] = [];
  fail = false;
  sign(tx: { to: Address; data: Hex; gas: bigint }, attach?: string | { purpose: string }) {
    if (this.fail) return Promise.reject(new Error('no relayer funds'));
    const purpose = typeof attach === 'object' ? attach.purpose : String(attach);
    this.signed.push({ ...tx, purpose });
    const hash = keccak256(toHex(`${purpose} ${String(this.signed.length)}`));
    return Promise.resolve({
      relayer: SUPPLIER,
      nonce: this.signed.length,
      raw: '0x01',
      hash,
    } as Signed);
  }
  enqueue(s: Signed) {
    this.queued.push(s);
  }
}

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

async function request(n: number): Promise<Hex> {
  const id = keccak256(toHex(`decision request ${String(n)}`));
  await store.createRequest({
    id,
    account: ACCOUNT,
    vault: VAULT,
    invoiceHash: keccak256(toHex(`invoice ${String(n)}`)),
    payTo: SUPPLIER,
    amount: 1000n,
    deadline: 2_000_000_000,
    agentSig: AGENT_SIG,
    agentAddress: null,
    document: null,
  });
  return id;
}

const evidence = { checker: 'countersign-checker/1', findings: [{ check: 'amount', ok: false }] };
const decision = (id: Hex, outcome: number = OUTCOME.held) => ({
  invoiceHash: keccak256(toHex(`invoice of ${id}`)),
  outcome,
  reasonHash: reasonHash('amount_mismatch'),
  evidenceHash: evidenceHash(evidence),
});
const CHECKER_SIG: Hex = `0x${'cd'.repeat(65)}`;
const OWNER_SIGS: OwnerSig[] = [
  {
    owner: 0,
    auth: {
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
      challengeIndex: 23n,
      typeIndex: 1n,
      authenticatorData: `0x${'33'.repeat(37)}`,
      clientDataJSON: '{"type":"webauthn.get","challenge":"x"}',
    },
  },
];

describe('recording decisions on Monad', () => {
  it('sends a checker’s hold as recordDecision, with the checker’s signature, to the payment’s vault', async () => {
    const pool = new FakePool();
    const recorder = new DecisionRecorder({ store, pool, enabled: true });
    const id = await request(1);
    await recorder.record({
      requestId: id,
      vault: VAULT,
      decidedBy: 'checker',
      decision: decision(id),
      checkerSig: CHECKER_SIG,
    });
    expect(pool.signed).toHaveLength(1);
    const sent = pool.signed[0];
    expect(sent?.to).toBe(VAULT);
    expect(sent?.purpose).toBe(`decision:${id}`);
    expect(sent?.gas).toBe(94_000n);
    const call = decodeFunctionData({ abi: orderVaultAbi, data: sent?.data ?? '0x' });
    expect(call.functionName).toBe('recordDecision');
    expect(call.args).toEqual([decision(id), CHECKER_SIG]);
    expect(pool.queued).toHaveLength(1);
    expect((await store.decisionRecord(id))?.txHash).toBe(pool.queued[0]?.hash);
  });

  it('sends an owner’s refusal as recordDecisionByOwner, with the passkey’s signature', async () => {
    const pool = new FakePool();
    const recorder = new DecisionRecorder({ store, pool, enabled: true });
    const id = await request(2);
    await recorder.record({
      requestId: id,
      vault: VAULT,
      decidedBy: 'owner',
      decision: decision(id, OUTCOME.refused),
      ownerSigs: OWNER_SIGS,
    });
    const call = decodeFunctionData({ abi: orderVaultAbi, data: pool.signed[0]?.data ?? '0x' });
    expect(call.functionName).toBe('recordDecisionByOwner');
    expect(call.args[0]).toEqual(decision(id, OUTCOME.refused));
    expect(call.args[1]).toEqual(OWNER_SIGS);
  });

  it('records a request’s decision once, however often it is asked', async () => {
    const pool = new FakePool();
    const recorder = new DecisionRecorder({ store, pool, enabled: true });
    const id = await request(3);
    const d = {
      requestId: id,
      vault: VAULT,
      decidedBy: 'checker' as const,
      decision: decision(id),
      checkerSig: CHECKER_SIG,
    };
    await Promise.all([recorder.record(d), recorder.record(d), recorder.record(d)]);
    expect(pool.signed).toHaveLength(1);
  });

  it('keeps the decision when recording is off or fails, and sends it on resume', async () => {
    const off = new FakePool();
    const id = await request(4);
    await new DecisionRecorder({ store, pool: off, enabled: false }).record({
      requestId: id,
      vault: VAULT,
      decidedBy: 'checker',
      decision: decision(id),
      checkerSig: CHECKER_SIG,
    });
    expect(off.signed).toHaveLength(0);
    expect(await store.decisionRecord(id)).toMatchObject({ decidedBy: 'checker', txHash: null });

    const broke = new FakePool();
    broke.fail = true;
    const id2 = await request(5);
    // A failure to record never fails the caller: the payment's own status is already stored.
    await new DecisionRecorder({ store, pool: broke, enabled: true }).record({
      requestId: id2,
      vault: VAULT,
      decidedBy: 'checker',
      decision: decision(id2),
      checkerSig: CHECKER_SIG,
    });

    const pool = new FakePool();
    await new DecisionRecorder({ store, pool, enabled: true }).resume();
    expect(pool.signed.map((s) => s.purpose).sort()).toEqual(
      [`decision:${id}`, `decision:${id2}`].sort(),
    );
    expect(await store.unsentDecisionRecords()).toEqual([]);
  });

  it('after a restart, links a transaction already signed for it instead of signing another', async () => {
    const id = await request(6);
    await store.addDecisionRecord({
      requestId: id,
      vault: VAULT,
      decidedBy: 'checker',
      decision: decision(id),
      sigs: CHECKER_SIG,
    });
    const hash = keccak256(toHex('signed before the crash'));
    await database.db.insert(relayerTxs).values({
      hash,
      relayer: SUPPLIER,
      nonce: 7,
      raw: '0x02',
      purpose: `decision:${id}`,
    });
    const pool = new FakePool();
    await new DecisionRecorder({ store, pool, enabled: true }).resume();
    expect(pool.signed).toHaveLength(0);
    expect((await store.decisionRecord(id))?.txHash).toBe(hash);
  });
});
