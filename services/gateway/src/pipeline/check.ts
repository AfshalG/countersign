import type { Address, Hex } from 'viem';
import type { WebsiteProofs } from '../proofs/website.js';
import type { Reason } from '@countersign/shared';
import type { Chain, PaymentCall } from '../chain/types.js';
import type { DecodedRefusal } from '../chain/refusals.js';
import type { Checker, CheckResult } from '../checker.js';
import type { PaymentRequestRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { paymentOf, type Payment } from '../payment.js';

/** What deciding a payment needs: the chain, the checker and its time limit. Nothing is stored. */
export type EvaluateDeps = {
  chain: Pick<Chain, 'simulate' | 'addressOnFile'>;
  checker: Checker;
  chainId: number;
  checkerTimeoutMs: number;
  /** Slice 15 (D21): whether the supplier's website stopped listing the address on file. */
  websites?: Pick<WebsiteProofs, 'websiteChanged'>;
};

export type CheckDeps = EvaluateDeps & {
  store: Store;
  /** How long a request taken for checking stays claimed; another worker re-checks it after that. */
  leaseMs?: number;
};

/** How a payment was decided. A dry run never carries a checker signature. */
export type Outcome =
  | { status: 'released'; decidedBy: 'checker'; checkerSig: Hex | undefined; evidence: unknown }
  | {
      status: 'held' | 'blocked';
      reason: Reason;
      decidedBy: 'rule' | 'checker';
      evidence: unknown;
      detail?: unknown;
    };

/** A simulation the RPC could not answer: the request stays in `checking` and is tried again. */
export class SimulationUnavailable extends Error {
  constructor(cause: unknown) {
    super(`simulation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SimulationUnavailable';
  }
}

async function simulate(
  chain: EvaluateDeps['chain'],
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
 * What the contract's refusal shows the owner. For an address not on file, the address on file
 * goes beside the invoice's (Slice 6 holds look-alikes so the owner can compare them, character by
 * character); if it cannot be read, the payment is still held, with the invoice's address alone.
 */
async function evidenceOf(deps: EvaluateDeps, row: PaymentRequestRow, contract: string) {
  if (contract !== 'PayToNotOnFile') return { contract };
  const invoice = row.payTo as Address;
  try {
    const onFile = await deps.chain.addressOnFile(row.account as Address, row.vault as Address);
    return { contract, payTo: { onFile, invoice } };
  } catch {
    return { contract, payTo: { invoice } };
  }
}

/**
 * Decides one payment, in the decision model's order (architecture, "The Decision Model"):
 *
 * 1. The contract's own rules. The vault checks every rule before any signature, so simulating
 *    the payment with the agent's signature and no checker signature costs nothing and answers
 *    "would every hard rule pass?": the expected refusal is InvalidCheckerSignature. Any other
 *    refusal blocks or holds the request with the contract's reason.
 * 2. The checker, within its time limit. An error or a timeout is a hold (money rule 1).
 * 3. If the checker releases it, the payment is simulated again with the checker's signature;
 *    only a payment the contract would accept is released.
 *
 * With `dryRun` (POST /v1/checks) the checker is told not to sign and step 3 is skipped: a check
 * must never hand anyone a signature that, with the agent's, could pay.
 */
export async function evaluate(
  deps: EvaluateDeps,
  row: PaymentRequestRow,
  options: { dryRun?: boolean } = {},
): Promise<Outcome> {
  const vault = row.vault as Address;
  const agentSig = row.agentSig as Hex;
  const payment = paymentOf(row);

  const rules = await simulate(deps.chain, vault, payment, {
    kind: 'pay',
    agentSig,
    checkerSig: '0x',
  });
  if (rules?.error !== 'InvalidCheckerSignature') {
    const refusal = rules ?? {
      error: 'succeeded without a checker signature',
      status: 'held' as const,
      reason: 'checker_unavailable' as const,
    };
    return {
      status: refusal.status,
      reason: refusal.reason,
      decidedBy: 'rule',
      evidence: await evidenceOf(deps, row, refusal.error),
      detail: { contract: refusal.error },
    };
  }

  // Evidence that expires (D21): the supplier's own website no longer lists the address on file.
  // A failure to look never holds a payment; only a proven change does.
  const changed = await deps.websites?.websiteChanged(row).catch((e: unknown) => {
    console.error(`website evidence ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (changed)
    return {
      status: 'held',
      reason: 'website_changed',
      decidedBy: 'rule',
      evidence: { website: changed },
      detail: { website: changed.url },
    };

  let result: CheckResult;
  try {
    result = await deps.checker.check(
      { request: row, payment, chainId: deps.chainId, dryRun: options.dryRun === true },
      AbortSignal.timeout(deps.checkerTimeoutMs),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: 'held',
      reason: 'checker_unavailable',
      decidedBy: 'checker',
      evidence: { checker: message },
      detail: { checker: message },
    };
  }
  if (result.verdict === 'hold') {
    return {
      status: 'held',
      reason: result.reason,
      decidedBy: 'checker',
      evidence: result.evidence,
    };
  }
  if (options.dryRun === true) {
    return {
      status: 'released',
      decidedBy: 'checker',
      checkerSig: undefined,
      evidence: result.evidence,
    };
  }

  const signed = await simulate(deps.chain, vault, payment, {
    kind: 'pay',
    agentSig,
    checkerSig: result.checkerSig,
  });
  if (signed !== undefined) {
    return {
      status: signed.status,
      reason: signed.reason,
      decidedBy: 'rule',
      evidence: { contract: signed.error, checker: result.evidence },
      detail: { contract: signed.error },
    };
  }
  return {
    status: 'released',
    decidedBy: 'checker',
    checkerSig: result.checkerSig,
    evidence: result.evidence,
  };
}

/**
 * Checks one stored request and records the outcome. A request still in `requested` is moved
 * to `checking` first (if another worker got there first, nothing happens). A request already in
 * `checking` (recovery) is checked again.
 */
export async function checkOne(deps: CheckDeps, row: PaymentRequestRow): Promise<void> {
  const { store } = deps;
  const lease = { leaseUntil: new Date(Date.now() + (deps.leaseMs ?? 30_000)) };
  if (
    row.status === 'requested' &&
    !(await store.transition(row.id, 'requested', 'checking', lease))
  )
    return;
  if (row.status !== 'requested' && row.status !== 'checking') return;

  const outcome = await evaluate(deps, row);
  const checkedAt = new Date();
  if (outcome.status === 'released') {
    // Only a dry run releases without a signature; a stored release without one is a bug, so it
    // stays in `checking` (retried) rather than being released.
    if (outcome.checkerSig === undefined)
      throw new Error('a stored release has no checker signature');
    await store.transition(row.id, 'checking', 'released', {
      checkedAt,
      decidedBy: outcome.decidedBy,
      checkerSig: outcome.checkerSig,
      evidence: outcome.evidence,
    });
    return;
  }
  await store.transition(row.id, 'checking', outcome.status, {
    checkedAt,
    reason: outcome.reason,
    decidedBy: outcome.decidedBy,
    evidence: outcome.evidence,
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  });
}
