import {
  bigint,
  bigserial,
  boolean,
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

/**
 * Relayer transactions that are not payments (judge-mode setup): stored with their nonce in the
 * same database transaction, as payments store theirs on the request, so a restart re-sends them
 * unchanged and no relayer is left stuck behind a nonce that was reserved but never sent.
 */
export const relayerTxs = pgTable('relayer_txs', {
  hash: text('hash').primaryKey(),
  relayer: text('relayer').notNull(),
  nonce: integer('nonce').notNull(),
  raw: text('raw').notNull(),
  purpose: text('purpose').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  finalAt: at('final_at'),
  status: text('status').$type<'success' | 'reverted'>(),
});

/**
 * Accounts whose orders the gateway indexes (Slice 12). `indexedTo` is the last finalized block
 * whose order events have been applied; the indexer resumes from there after a restart.
 */
export const accounts = pgTable('accounts', {
  address: text('address').primaryKey(),
  label: text('label'),
  indexedTo: bigint('indexed_to', { mode: 'number' }).notNull(),
  registeredAt: at('registered_at').notNull().defaultNow(),
});

/**
 * Orders the accounts approved, from `OrderApproved` and `OrderClosed` events. What is left in an
 * order and its supplier's address on file are read from the chain when asked, never stored, so
 * they cannot go stale.
 */
export const orders = pgTable(
  'orders',
  {
    vault: text('vault').primaryKey(),
    account: text('account').notNull(),
    orderId: text('order_id').notNull(),
    supplierId: text('supplier_id').notNull(),
    orderHash: text('order_hash').notNull(),
    /** USDC base units set aside for the order (uint256 as a decimal string). */
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    expiry: bigint('expiry', { mode: 'number' }).notNull(),
    closed: boolean('closed').notNull().default(false),
    approvedBlock: bigint('approved_block', { mode: 'number' }).notNull(),
  },
  (t) => [index('orders_account_idx').on(t.account, t.closed)],
);

export const PROPOSAL_STATUSES = ['pending', 'approved', 'refused', 'expired'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * A supplier and an order an agent proposed from a quote it read (money rule 8: nothing changes
 * until the owner's passkey signs). The id is derived from (account, document hash), so the same
 * quote proposed twice is one proposal.
 */
export const proposals = pgTable('proposals', {
  id: text('id').primaryKey(),
  account: text('account').notNull(),
  supplierName: text('supplier_name').notNull(),
  website: text('website'),
  /** The payment address as the agent read it; the website check (Slice 15) confirms it or not. */
  payTo: text('pay_to').notNull(),
  amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
  expiry: bigint('expiry', { mode: 'number' }).notNull(),
  documentHash: text('document_hash').notNull(),
  document: jsonb('document'),
  status: text('status').$type<ProposalStatus>().notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  decidedAt: at('decided_at'),
});

/**
 * Judge mode (Slice 9 part 4): an account created for a new passkey. `plan` fixes the three setup
 * actions its passkey signs (src/demo/plan.ts), so the challenges shown are the ones checked.
 */
export const DEMO_STATUSES = ['creating', 'awaiting_passkey', 'setting_up', 'ready'] as const;
export type DemoStatus = (typeof DEMO_STATUSES)[number];

export const demoAccounts = pgTable('demo_accounts', {
  account: text('account').primaryKey(),
  qx: text('qx').notNull(),
  qy: text('qy').notNull(),
  plan: jsonb('plan').notNull(),
  status: text('status').$type<DemoStatus>().notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  readyAt: at('ready_at'),
});

export type PaymentRequestRow = typeof paymentRequests.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type DemoAccountRow = typeof demoAccounts.$inferSelect;
export type RelayerTxRow = typeof relayerTxs.$inferSelect;
