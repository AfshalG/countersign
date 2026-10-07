import type { Address, Hex } from 'viem';
import type { Chain, PaymentCall } from '../chain/types.js';
import type { DecodedRefusal } from '../chain/refusals.js';
import type { Checker, CheckResult } from '../checker.js';
import type { PaymentRequestRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { paymentOf, type Payment } from '../payment.js';

export type CheckDeps = {
  store: Store;
  chain: Chain;
  checker: Checker;
  chainId: number;
  checkerTimeoutMs: number;
};

/** A simulation the RPC could not answer: the request stays in `checking` and is tried again. */
export class SimulationUnavailable extends Error {
  constructor(cause: unknown) {
    super(`simulation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SimulationUnavailable';
  }
}

async function simulate(
  chain: Chain,
  vault: Address,
  payment: Payment,
  call: PaymentCall,
): Promise<DecodedRefusal | undefined> {
  try {
    return await chain.simulate(vault, payment, call);
  } catch (e) {
    throw new SimulationUnavailable(e);
  }
}

/**
 * Checks one request, in the decision model's order (architecture, "The Decision Model"):
 *
 * 1. The contract's own rules. The vault checks every rule before any signature, so simulating
 *    the payment with the agent's signature and no checker signature costs nothing and answers
 *    "would every hard rule pass?": the expected refusal is InvalidCheckerSignature. Any other
 *    refusal blocks or holds the request with the contract's reason.
 * 2. The checker, within its time limit. An error or a timeout is a hold (money rule 1).
 * 3. If the checker releases it, the payment is simulated again with the checker's signature;
 *    only a payment the contract would accept is marked released.
 *
 * A request still in `requested` is moved to `checking` first (if another worker got there
 * first, nothing happens). A request already in `checking` (recovery) is checked again.
 */
export async function checkOne(deps: CheckDeps, row: PaymentRequestRow): Promise<void> {
  const { store, chain, checker } = deps;
  if (row.status === 'requested' && !(await store.transition(row.id, 'requested', 'checking')))
    return;
  if (row.status !== 'requested' && row.status !== 'checking') return;

  const vault = row.vault as Address;
  const agentSig = row.agentSig as Hex;
  const payment = paymentOf(row);
  const finish = (
    status: 'held' | 'blocked' | 'released',
    patch: Parameters<Store['transition']>[3],
  ) => store.transition(row.id, 'checking', status, { checkedAt: new Date(), ...patch });

  const rules = await simulate(chain, vault, payment, { kind: 'pay', agentSig, checkerSig: '0x' });
  if (rules?.error !== 'InvalidCheckerSignature') {
    const refusal = rules ?? {
      error: 'succeeded without a checker signature',
      status: 'held' as const,
      reason: 'checker_unavailable' as const,
    };
    await finish(refusal.status, {
      reason: refusal.reason,
      decidedBy: 'rule',
      evidence: { contract: refusal.error },
      detail: { contract: refusal.error },
    });
    return;
  }

  let result: CheckResult;
  try {
    result = await checker.check(
      { request: row, payment, chainId: deps.chainId },
      AbortSignal.timeout(deps.checkerTimeoutMs),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finish('held', {
      reason: 'checker_unavailable',
      decidedBy: 'checker',
      evidence: { checker: message },
      detail: { checker: message },
    });
    return;
  }
  if (result.verdict === 'hold') {
    await finish('held', {
      reason: result.reason,
      decidedBy: 'checker',
      evidence: result.evidence,
    });
    return;
  }

  const signed = await simulate(chain, vault, payment, {
    kind: 'pay',
    agentSig,
    checkerSig: result.checkerSig,
  });
  if (signed !== undefined) {
    await finish(signed.status, {
      reason: signed.reason,
      decidedBy: 'rule',
      evidence: { contract: signed.error, checker: result.evidence },
      detail: { contract: signed.error },
    });
    return;
  }
  await finish('released', {
    decidedBy: 'checker',
    checkerSig: result.checkerSig,
    evidence: result.evidence,
  });
}
