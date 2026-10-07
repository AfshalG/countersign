import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { DecidedBy, PaymentStatus, Reason } from '@countersign/shared';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * One payment request per (account, vault, invoice hash): the id is derived from those
 * (src/ids.ts), so a second submission finds the first. Each status change is written with
 * its row in `payment_events`, in the same transaction.
 */
export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: text('id').primaryKey(),
    runId: text('run_id'),
    account: text('account').notNull(),
    vault: text('vault').notNull(),
    invoiceHash: text('invoice_hash').notNull(),
    payTo: text('pay_to').notNull(),
    /** USDC base units as a decimal string (uint256). */
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    deadline: bigint('deadline', { mode: 'number' }).notNull(),
    agentSig: text('agent_sig').notNull(),
    /** What the checker reads: the invoice's source or file reference and its fields. */
    document: jsonb('document'),

    status: text('status').$type<PaymentStatus>().notNull(),
    reason: text('reason').$type<Reason>(),
    decidedBy: text('decided_by').$type<DecidedBy>(),
    evidence: jsonb('evidence'),

    /** How the payment is released: the checker's signature, or the owner's passkey. */
    checkerSig: text('checker_sig'),
    ownerAuth: jsonb('owner_auth'),

    relayer: text('relayer'),
    relayerNonce: integer('relayer_nonce'),
    /** The signed transaction, kept so a crash between signing and sending re-sends the same one. */
    rawTx: text('raw_tx'),
    txHash: text('tx_hash'),
    blockNumber: bigint('block_number', { mode: 'number' }),

    requestedAt: at('requested_at').notNull().defaultNow(),
    checkedAt: at('checked_at'),
    decidedAt: at('decided_at'),
    sentAt: at('sent_at'),
    proposedAt: at('proposed_at'),
    votedAt: at('voted_at'),
    finalizedAt: at('finalized_at'),
    updatedAt: at('updated_at').notNull().defaultNow(),
    /** A worker's claim on the row; another worker may take it once this has passed. */
    leaseUntil: at('lease_until'),
  },
  (t) => [
    index('payment_requests_status_idx').on(t.status, t.leaseUntil),
    index('payment_requests_run_idx').on(t.runId),
    index('payment_requests_tx_idx').on(t.txHash),
  ],
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => paymentRequests.id),
    fromStatus: text('from_status').$type<PaymentStatus>(),
    toStatus: text('to_status').$type<PaymentStatus>().notNull(),
    reason: text('reason').$type<Reason>(),
    at: at('at').notNull().defaultNow(),
    detail: jsonb('detail'),
  },
  (t) => [index('payment_events_request_idx').on(t.requestId, t.id)],
);

export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  account: text('account').notNull(),
  size: integer('size').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

/** The next nonce each relayer will use, so a restart resumes where it stopped. */
export const relayerNonces = pgTable('relayer_nonces', {
  address: text('address').primaryKey(),
  nextNonce: integer('next_nonce').notNull(),
});

export type PaymentRequestRow = typeof paymentRequests.$inferSelect;
