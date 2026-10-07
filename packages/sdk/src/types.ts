import type { Address, Hex } from 'viem';

export type PaymentStatus =
  | 'requested'
  | 'checking'
  | 'held'
  | 'released'
  | 'settling'
  | 'settled'
  | 'blocked'
  | 'refused'
  | 'expired'
  | 'failed';

/** A payment request as the gateway reports it, plus the reason in plain words. */
export type PaymentRequest = {
  id: Hex;
  runId: Hex | null;
  status: PaymentStatus;
  /** A typed reason (`address_mismatch`, `over_limit`, …), or null. */
  reason: string | null;
  /** The same reason in plain words, for a person. */
  reasonText: string | null;
  decidedBy: string | null;
  account: Address;
  vault: Address;
  payTo: Address;
  /** USDC base units (6 decimals). */
  amount: string;
  invoiceHash: Hex;
  deadline: number;
  /** On an address not on file: `{ contract, payTo: { onFile, invoice } }`. */
  evidence: unknown;
  tx: {
    hash: Hex | null;
    relayer: Address | null;
    nonce: number | null;
    block: number | null;
    proposedAt: string | null;
    votedAt: string | null;
    finalizedAt: string | null;
  };
  timings: { checkMs: number | null; personMs: number | null; settleMs: number | null };
  /** A page a person can open: the status, the reason, both addresses on a mismatch. */
  statusUrl: string;
};

/** An open order: the only supplier, address and amount the agent can pay against it. */
export type Order = {
  orderId: Hex;
  vault: Address;
  supplierId: Hex;
  /** The supplier's address on file: the only address this order pays. */
  payTo: Address;
  supplierActive: boolean;
  /** Unix seconds when the address on file can first be paid. */
  activeAfter: number;
  /** USDC base units set aside. */
  amount: string;
  /** USDC base units left, read from the chain when listed. */
  remaining: string;
  expiry: number;
  approvedBlock: number;
};

export type CheckVerdict = {
  verdict: 'would_settle' | 'held' | 'blocked';
  reason: string | null;
  reasonText: string | null;
  decidedBy: string;
  evidence: unknown;
};

export type Run = { runId: Hex; requests: { id: Hex; status: PaymentStatus }[] };

export type RunView = {
  runId: Hex;
  size: number;
  byStatus: Record<PaymentStatus, number>;
  requests: PaymentRequest[];
};

export type Proposal = {
  id: Hex;
  account: Address;
  status: 'pending' | 'approved' | 'refused' | 'expired';
  supplierName: string;
  website: string | null;
  payTo: Address;
  amount: string;
  expiry: number;
  documentHash: Hex;
  /** Where the owner reviews it. Nothing changes until their passkey signs. */
  approvalUrl: string;
  createdAt: string;
};

/** One change on the live feed. */
export type StatusChange = {
  requestId: Hex;
  runId: Hex | null;
  from: PaymentStatus | null;
  to: PaymentStatus;
  reason: string | null;
};

/** An invoice as the agent read it. The address is the invoice's; the account pays only the one on file. */
export type Invoice = {
  /** The supplier's invoice number; spacing and case do not matter ("inv 0042" is "INV 0042"). */
  number: string;
  /** "12.50" (USDC) or base units as a bigint. Never a float. */
  amount: string | bigint;
  /** The payment address printed on the invoice. */
  payTo: Address;
  /** What the checker reads: the invoice's text or fields. */
  document?: unknown;
};

/**
 * What `pay` returns: the request, and whether it was already there. A resent invoice (the same
 * supplier and number) is the first request again, not a new payment: `duplicate` is then true.
 */
export type PaymentResult = PaymentRequest & { duplicate: boolean };

export type PayInput = {
  /** An order from `orders()`, or its id. */
  order: Order | Hex;
  invoice: Invoice;
  /** Unix seconds after which the vault refuses the payment; default an hour from now. */
  deadline?: number;
};
