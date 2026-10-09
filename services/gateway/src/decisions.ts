import { encodeFunctionData, type Address, type Hex } from 'viem';
import { GAS_LIMITS, orderVaultAbi } from '@countersign/chain';
import type { Decision, OwnerSig } from './chain/types.js';
import type { Store } from './db/store.js';
import { sigsOf, storedSigs } from './owner/signers.js';
import type { RelayerPool } from './relay/pool.js';

/**
 * Decisions written on Monad (Slice 18, S18-1): a checker's hold (`recordDecision`, with the
 * checker's signature) and an owner's refusal (`recordDecisionByOwner`, with the passkey's), each
 * carrying the hash of the evidence it was made on. The vault emits `DecisionRecorded`; nothing is
 * stored on chain and no money moves.
 *
 * Recording follows the decision and never changes it: the payment's status is stored first, and
 * a failure here is logged and retried on the next resume. A decision is kept (`decision_records`)
 * before its transaction is signed, so a restart sends what was not sent, and links one that was
 * (its relayer transaction carries the purpose `decision:<request id>`) rather than signing again.
 */

export type DecisionToRecord =
  | {
      requestId: Hex;
      vault: Address;
      decidedBy: 'checker';
      decision: Decision;
      checkerSig: Hex;
    }
  | {
      requestId: Hex;
      vault: Address;
      decidedBy: 'owner';
      decision: Decision;
      ownerSigs: OwnerSig[];
    };

export type DecisionRecorderDeps = {
  store: Pick<
    Store,
    | 'addDecisionRecord'
    | 'decisionRecord'
    | 'setDecisionTx'
    | 'unsentDecisionRecords'
    | 'relayerTxFor'
  >;
  pool: Pick<RelayerPool, 'sign' | 'enqueue'>;
  /** RECORD_DECISIONS (S18-4): each costs testnet MON; off, decisions are kept and sent on resume. */
  enabled: boolean;
};

export const decisionPurpose = (requestId: string) => `decision:${requestId}`;

export class DecisionRecorder {
  /** Requests being sent now, so the same decision asked for twice at once is signed once. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: DecisionRecorderDeps) {}

  /** Keeps the decision and sends it. Never throws: the decision itself is already stored. */
  async record(d: DecisionToRecord): Promise<void> {
    try {
      await this.deps.store.addDecisionRecord({
        requestId: d.requestId,
        vault: d.vault,
        decidedBy: d.decidedBy,
        decision: d.decision,
        sigs: d.decidedBy === 'checker' ? d.checkerSig : storedSigs(d.ownerSigs),
      });
      if (this.deps.enabled) await this.send(d.requestId);
    } catch (e) {
      console.error(
        `decision ${d.requestId}: not recorded yet: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Sends every decision whose transaction was never signed. */
  async resume(): Promise<void> {
    if (!this.deps.enabled) return;
    for (const r of await this.deps.store.unsentDecisionRecords())
      await this.send(r.requestId).catch((e: unknown) => {
        console.error(
          `decision ${r.requestId}: not recorded yet: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }

  private send(requestId: string): Promise<void> {
    const running = this.inFlight.get(requestId);
    if (running) return running;
    const sending = this.sendOnce(requestId).finally(() => this.inFlight.delete(requestId));
    this.inFlight.set(requestId, sending);
    return sending;
  }

  private async sendOnce(requestId: string): Promise<void> {
    const { store, pool } = this.deps;
    const rec = await store.decisionRecord(requestId);
    if (!rec || rec.txHash) return;
    const purpose = decisionPurpose(requestId);
    // Signed before a restart: the pool sends that transaction again; link it, never sign twice.
    const earlier = await store.relayerTxFor(purpose);
    if (earlier) {
      await store.setDecisionTx(requestId, earlier.hash);
      return;
    }
    const decision = rec.decision as Decision;
    const data =
      rec.decidedBy === 'checker'
        ? encodeFunctionData({
            abi: orderVaultAbi,
            functionName: 'recordDecision',
            args: [decision, rec.sigs as Hex],
          })
        : encodeFunctionData({
            abi: orderVaultAbi,
            functionName: 'recordDecisionByOwner',
            args: [decision, sigsOf(rec.sigs)],
          });
    // Fixed limits: Monad charges the limit, not the gas used. A refusal is one owner (D36).
    const gas =
      rec.decidedBy === 'checker' ? GAS_LIMITS.recordDecision : GAS_LIMITS.recordDecisionByOwner;
    const signed = await pool.sign({ to: rec.vault as Address, data, gas }, { purpose });
    await store.setDecisionTx(requestId, signed.hash);
    pool.enqueue(signed);
  }
}
