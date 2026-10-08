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

/**
 * Each reason in plain words, for people: the status page, the agent's tool text, the SDK's
 * messages. One place, so every face says the same thing. (`Record<Reason, …>` makes a new reason
 * without words a type error.)
 */
export const REASON_TEXT: Record<Reason, string> = {
  malformed:
    'The payment was not well formed (an amount of zero, a deadline passed, or a bad agent signature).',
  over_limit:
    'The amount is over a limit the owner set: per payment, for a newly added address, or what is left in the order.',
  order_closed: 'The order is closed or has expired.',
  supplier_unknown: 'The supplier is not on file.',
  supplier_inactive: 'The owner has switched this supplier off.',
  address_mismatch: "The invoice's payment address is not the supplier's address on file.",
  address_not_yet_active: "The supplier's address on file is new and still in its waiting period.",
  supplier_mismatch: "The invoice is from a different supplier than the order's.",
  items_mismatch: "The invoice's items differ from the order's.",
  amount_mismatch: "The invoice's amount differs from what the order allows.",
  duplicate_invoice: 'This invoice has already been paid.',
  document_layers_differ: "The PDF's text and its rendered page disagree.",
  checker_unavailable: 'The checker did not answer in time, so the payment waits for a person.',
  checker_unsure: 'The checker could not tell, so the payment waits for a person.',
  paused: 'The owner has paused the account.',
  policy_inactive: "The account's rules are not set or have expired.",
  user_refused: 'The owner refused it.',
  expired: 'It was not decided before its deadline.',
  reverted: 'The transaction failed on chain; no money moved.',
  dropped: 'The transaction never reached a block; no money moved.',
};

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
  // Several approvers (D36): payWithOwner asks the account to count the owners. The gateway
  // gathers signatures until there are enough, so these mean the owners changed meanwhile.
  NotEnoughSigners: { status: 'held', reason: 'checker_unavailable' },
  OwnersOutOfOrder: { status: 'held', reason: 'checker_unavailable' },
  UnknownOwner: { status: 'held', reason: 'checker_unavailable' },
};

/** Fail closed: an error we do not recognise is a hold, never a pass. */
export function refusalFor(errorName: string): Refusal {
  return CONTRACT_REFUSALS[errorName] ?? { status: 'held', reason: 'checker_unavailable' };
}
