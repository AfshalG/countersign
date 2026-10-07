/**
 * The typed state of a payment request (money rule 6: change it here first). Every request
 * moves only along TRANSITIONS and ends in exactly one final status.
 */

export const PAYMENT_STATUSES = [
  'requested',
  'checking',
  'held',
  'released',
  'settling',
  'settled',
  'blocked',
  'refused',
  'expired',
  'failed',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FINAL_STATUSES = [
  'settled',
  'blocked',
  'refused',
  'expired',
  'failed',
] as const satisfies readonly PaymentStatus[];
export type FinalStatus = (typeof FINAL_STATUSES)[number];

/** A typed code for every status other than settled. */
export const REASONS = [
  'malformed',
  'over_limit',
  'order_closed',
  'supplier_unknown',
  'supplier_inactive',
  'address_mismatch',
  'address_not_yet_active',
  'supplier_mismatch',
  'items_mismatch',
  'amount_mismatch',
  'duplicate_invoice',
  'document_layers_differ',
  'checker_unavailable',
  'checker_unsure',
  'paused',
  'policy_inactive',
  'user_refused',
  'expired',
  'reverted',
  'dropped',
] as const;
export type Reason = (typeof REASONS)[number];

/** Who decided: code rules, the checker, or the person (pay once, or refuse). */
export const DECIDED_BY = ['rule', 'checker', 'user_once', 'user_refused'] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  requested: ['checking', 'blocked'],
  // A hard limit can also surface while checking (the contract's own simulation).
  checking: ['held', 'released', 'blocked'],
  held: ['released', 'refused', 'expired'],
  // A released payment the chain will no longer accept (order closed meanwhile) fails.
  released: ['settling', 'failed'],
  settling: ['settled', 'failed'],
  settled: [],
  blocked: [],
  refused: [],
  expired: [],
  failed: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(status: PaymentStatus): status is FinalStatus {
  return (FINAL_STATUSES as readonly PaymentStatus[]).includes(status);
}

export type Refusal = { status: 'blocked' | 'held'; reason: Reason };

/**
 * Every named error a payment can raise in the contracts (contracts/src/CountersignErrors.sol),
 * with what the gateway records. Held: a person can resolve it (wrong or new address, paused,
 * policy lapsed). Blocked: nobody should pay it (over a limit, order closed, already paid,
 * a malformed request).
 */
export const CONTRACT_REFUSALS: Record<string, Refusal> = {
  DeadlinePassed: { status: 'blocked', reason: 'malformed' },
  ZeroAmount: { status: 'blocked', reason: 'malformed' },
  InvalidAgentSignature: { status: 'blocked', reason: 'malformed' },
  AccountPaused: { status: 'held', reason: 'paused' },
  VaultClosed: { status: 'blocked', reason: 'order_closed' },
  OrderExpired: { status: 'blocked', reason: 'order_closed' },
  AlreadyPaid: { status: 'blocked', reason: 'duplicate_invoice' },
  SupplierInactive: { status: 'held', reason: 'supplier_inactive' },
  PayToNotOnFile: { status: 'held', reason: 'address_mismatch' },
  AddressNotYetActive: { status: 'held', reason: 'address_not_yet_active' },
  OverNewAddressCap: { status: 'blocked', reason: 'over_limit' },
  OverCap: { status: 'blocked', reason: 'over_limit' },
  OverRemaining: { status: 'blocked', reason: 'over_limit' },
  PolicyNotSet: { status: 'held', reason: 'policy_inactive' },
  PolicyExpired: { status: 'held', reason: 'policy_inactive' },
  InvalidCheckerSignature: { status: 'held', reason: 'checker_unavailable' },
  InvalidOwnerSignature: { status: 'held', reason: 'checker_unavailable' },
};

/** Fail closed: an error we do not recognise is a hold, never a pass. */
export function refusalFor(errorName: string): Refusal {
  return CONTRACT_REFUSALS[errorName] ?? { status: 'held', reason: 'checker_unavailable' };
}
