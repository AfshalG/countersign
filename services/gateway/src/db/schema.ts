import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { DecidedBy, PaymentStatus, Reason } from '@countersign/shared';

/** Why a website check has no proof (Slice 15). */
export const PROOF_ERRORS = [
  'no_website', // nothing to check: no website given or on file
  'no_file', // the site has no /.well-known/countersign.json
  'bad_file', // the file does not list one address as {"payTo":"0x…"}
  'not_configured', // this gateway has no Primus keys
  'primus_failed', // Primus could not prove it
  'record_failed', // proven, but the registry on Monad did not record it
  'timeout',
] as const;
export type ProofError = (typeof PROOF_ERRORS)[number];

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
    /** The address the agent's signature recovers to (Slice 19): its ERC-8004 agent, if registered. */
    agentAddress: text('agent_address'),
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
    /**
     * Set when released: the supplier and the invoice number as a person sees it (its skeleton,
     * 9 Oct). Unique per account, so a look-alike copy of an invoice already released is held,
     * even when the two are checked at the same moment.
     */
    invoiceKey: text('invoice_key'),
  },
  (t) => [
    index('payment_requests_status_idx').on(t.status, t.leaseUntil),
    index('payment_requests_run_idx').on(t.runId),
    index('payment_requests_tx_idx').on(t.txHash),
    uniqueIndex('payment_requests_invoice_key_idx').on(t.account, t.invoiceKey),
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

export type RunRow = typeof runs.$inferSelect;

/**
 * Every invoice each run sent (Slice 16). A request pays its invoice once and keeps the run that
 * first sent it (`payment_requests.run_id`); when two agents send the same invoice in different
 * runs at once, each run still lists it here.
 */
export const runRequests = pgTable(
  'run_requests',
  {
    runId: text('run_id').notNull(),
    requestId: text('request_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.requestId] }),
    index('run_requests_request_idx').on(t.requestId),
  ],
);

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
  /** The block it was final in (Slice 18: the payment record names it). */
  blockNumber: integer('block_number'),
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
  // Slice 15: the website check this proposal is shown and signed with. Fixed once it ends, so
  // every owner signs the same challenge (D36). `proofUrl` is the file checked, `proofSource`
  // whether it is the supplier's site on file or the one the proposal gave.
  proofStatus: text('proof_status').$type<'checking' | 'done'>(),
  proofUrl: text('proof_url'),
  proofSource: text('proof_source').$type<'on_file' | 'proposal'>(),
  proofId: bigint('proof_id', { mode: 'number' }),
  proofError: text('proof_error').$type<ProofError>(),
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

/**
 * ERC-8004 agents the gateway names on payments (Slice 19): an agent's id in the Identity
 * Registry and its `agentWallet`, the key that signs its payments, read from the chain when added
 * and again when the gateway starts.
 */
export const agents = pgTable('agents', {
  agentId: text('agent_id').primaryKey(),
  registry: text('registry').notNull(),
  wallet: text('wallet').notNull(),
  addedAt: at('added_at').notNull().defaultNow(),
});

export type PaymentRequestRow = typeof paymentRequests.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type DemoAccountRow = typeof demoAccounts.$inferSelect;
/**
 * Owners' passkey assertions gathered for one owner action until the account's threshold is met
 * (D36). Keyed by the digest signed (the action itself: its nonce and deadline, or the payment)
 * and the owner's key, not their index, since `setOwners` can renumber owners. `detail` is what
 * another owner needs to rebuild the same challenge (an unpause's deadline, an owner change's
 * keys). An action exists here only once a real owner has signed it.
 */
export const ownerSignatures = pgTable(
  'owner_signatures',
  {
    digest: text('digest').notNull(),
    qx: text('qx').notNull(),
    qy: text('qy').notNull(),
    account: text('account').notNull(),
    purpose: text('purpose').notNull(),
    auth: jsonb('auth').notNull(),
    detail: jsonb('detail'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.digest, t.qx, t.qy] }),
    index('owner_signatures_account_idx').on(t.account, t.purpose),
  ],
);

export type OwnerSignatureRow = typeof ownerSignatures.$inferSelect;
export type RelayerTxRow = typeof relayerTxs.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;

/**
 * WhatsApp (Slice 14, D31): a person who connected a WhatsApp number to an account. An owner signs
 * a one-off challenge with their passkey for a code (`whatsapp_links`), and sends the code to
 * Countersign's number from WhatsApp: that message is their consent, and it opens WhatsApp's
 * 24-hour window for free-form messages (`lastInboundAt`). STOP removes them.
 */
export const whatsappContacts = pgTable(
  'whatsapp_contacts',
  {
    account: text('account').notNull(),
    waId: text('wa_id').notNull(),
    connectedAt: at('connected_at').notNull().defaultNow(),
    lastInboundAt: at('last_inbound_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.account, t.waId] }),
    index('whatsapp_contacts_wa_idx').on(t.waId),
  ],
);

/** A connect code: issued for an account, usable once an owner has signed for it, then once. */
export const whatsappLinks = pgTable(
  'whatsapp_links',
  {
    code: text('code').primaryKey(),
    account: text('account').notNull(),
    expiresAt: at('expires_at').notNull(),
    signedAt: at('signed_at'),
    usedAt: at('used_at'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [index('whatsapp_links_account_idx').on(t.account, t.createdAt)],
);

/**
 * One message per decision and person: `subject` is the held payment's or the proposal's id, so
 * the same hold never messages a person twice. `status` follows WhatsApp's webhooks (sent,
 * delivered, read, failed); `skipped` records a message not sent, and why.
 */
export const whatsappMessages = pgTable(
  'whatsapp_messages',
  {
    subject: text('subject').notNull(),
    waId: text('wa_id').notNull(),
    account: text('account').notNull(),
    kind: text('kind').$type<'held' | 'proposal'>().notNull(),
    via: text('via').$type<'link' | 'template'>(),
    messageId: text('message_id'),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.subject, t.waId] }),
    index('whatsapp_messages_id_idx').on(t.messageId),
    index('whatsapp_messages_recent_idx').on(t.waId, t.createdAt),
  ],
);

export type WhatsappContactRow = typeof whatsappContacts.$inferSelect;
export type WhatsappMessageRow = typeof whatsappMessages.$inferSelect;

/**
 * Account tokens (Slice 12 part 2): a developer's test account calls the API with its own token,
 * which is allowed only that account's routes. Only the SHA-256 is kept. `generation` counts the
 * account's tokens and is in the challenge its owner signs, so one signature makes one token.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    account: text('account').notNull(),
    generation: integer('generation').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    revokedAt: at('revoked_at'),
  },
  (t) => [uniqueIndex('api_tokens_generation_idx').on(t.account, t.generation)],
);

/**
 * What a supplier's website listed (Slice 15): one row per check of a file URL. With a proof,
 * `proofHash` is the record in the SupplierProofs registry on Monad and `txHash` the transaction
 * that recorded it; without one, `error` says why. `listed` is the address the file listed, read
 * from Primus's proof (or from the file itself when the proof failed after reading it).
 */
export const websiteProofs = pgTable(
  'website_proofs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    url: text('url').notNull(),
    listed: text('listed'),
    signedAt: at('signed_at'),
    proofHash: text('proof_hash'),
    txHash: text('tx_hash'),
    error: text('error').$type<ProofError>(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [index('website_proofs_url_idx').on(t.url, t.createdAt)],
);

/**
 * The website each supplier was approved with (S15-4): a changed address is checked against this
 * site, never against one a new proposal gives.
 */
export const supplierWebsites = pgTable(
  'supplier_websites',
  {
    account: text('account').notNull(),
    supplierId: text('supplier_id').notNull(),
    url: text('url').notNull(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.account, t.supplierId] })],
);

export type WebsiteProofRow = typeof websiteProofs.$inferSelect;

/**
 * A supplier's bank account as an owner put it on file with their passkey (Slice 17): what a
 * bank-transfer invoice's account is compared with. Off chain: the contract pays only USDC, and a
 * bank transfer cannot be stopped from outside the bank, so this backs advice, not enforcement.
 */
export const supplierBanks = pgTable(
  'supplier_banks',
  {
    account: text('account').notNull(),
    supplierId: text('supplier_id').notNull(),
    holder: text('holder').notNull(),
    iban: text('iban'),
    bic: text('bic'),
    sortCode: text('sort_code'),
    accountNumber: text('account_number'),
    routingNumber: text('routing_number'),
    /** The owner's signature over exactly these details (bank_challenge), kept as evidence. */
    ownerAuth: jsonb('owner_auth').notNull(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.account, t.supplierId] })],
);

/** Each piece of advice given on a bank-transfer invoice (Slice 17), for the payment record. */
export const adviceChecks = pgTable(
  'advice_checks',
  {
    id: text('id').primaryKey(),
    account: text('account').notNull(),
    vault: text('vault').notNull(),
    supplierId: text('supplier_id').notNull(),
    advice: text('advice').$type<'match' | 'mismatch' | 'unsure'>().notNull(),
    reason: text('reason').$type<Reason>(),
    invoiceNumber: text('invoice_number'),
    documentHash: text('document_hash').notNull(),
    evidence: jsonb('evidence'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [index('advice_checks_account_idx').on(t.account, t.createdAt)],
);

export type SupplierBankRow = typeof supplierBanks.$inferSelect;
export type AdviceCheckRow = typeof adviceChecks.$inferSelect;

/**
 * A decision to be written on Monad with its evidence hash (Slice 18): a checker's hold
 * (`recordDecision`, the checker's signature) or an owner's refusal (`recordDecisionByOwner`, the
 * passkey's). Kept until its transaction is signed, so a restart sends what was not sent; its
 * finality is the relayer transaction's (`relayer_txs`, purpose `decision:<request id>:<by>`).
 */
export const decisionRecords = pgTable(
  'decision_records',
  {
    requestId: text('request_id')
      .notNull()
      .references(() => paymentRequests.id),
    vault: text('vault').notNull(),
    decidedBy: text('decided_by').$type<'checker' | 'owner'>().notNull(),
    /** The vault's `Decision`: invoiceHash, outcome, reasonHash, evidenceHash. */
    decision: jsonb('decision').notNull(),
    /** The checker's signature (hex), or the owners' (as stored by storedSigs). */
    sigs: jsonb('sigs').notNull(),
    txHash: text('tx_hash'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  // A payment can be decided twice: the checker holds it, then the owner refuses it. One each.
  (t) => [primaryKey({ columns: [t.requestId, t.decidedBy] })],
);

export type DecisionRecordRow = typeof decisionRecords.$inferSelect;
