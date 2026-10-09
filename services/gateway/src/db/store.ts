import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import {
  canTransition,
  type DecidedBy,
  type PaymentStatus,
  type Reason,
} from '@countersign/shared';
import type { Db } from './client.js';
import {
  accounts,
  agents,
  apiTokens,
  demoAccounts,
  orders,
  ownerSignatures,
  paymentEvents,
  relayerTxs,
  paymentRequests,
  proposals,
  runRequests,
  runs,
  supplierWebsites,
  supplierBanks,
  decisionRecords,
  type DecisionRecordRow,
  adviceChecks,
  type SupplierBankRow,
  type AdviceCheckRow,
  websiteProofs,
  whatsappContacts,
  whatsappLinks,
  whatsappMessages,
  type AccountRow,
  type AgentRow,
  type DemoAccountRow,
  type DemoStatus,
  type OrderRow,
  type OwnerSignatureRow,
  type RelayerTxRow,
  type RunRow,
  type PaymentRequestRow,
  type ProofError,
  type ProposalRow,
  type WebsiteProofRow,
  type WhatsappContactRow,
  type WhatsappMessageRow,
} from './schema.js';

export type NewRequest = {
  id: Hex;
  runId?: Hex | undefined;
  account: Address;
  vault: Address;
  invoiceHash: Hex;
  payTo: Address;
  amount: bigint;
  deadline: number;
  agentSig: Hex;
  /** Recovered from the agent's signature (Slice 19); null if it does not recover. */
  agentAddress?: Address | null;
  document?: unknown;
};

/** Fields a status change may set alongside the new status. */
export type TransitionPatch = Partial<
  Pick<
    PaymentRequestRow,
    | 'evidence'
    | 'checkerSig'
    | 'ownerAuth'
    | 'relayer'
    | 'relayerNonce'
    | 'rawTx'
    | 'txHash'
    | 'blockNumber'
    | 'checkedAt'
    | 'decidedAt'
    | 'sentAt'
    | 'proposedAt'
    | 'votedAt'
    | 'finalizedAt'
    | 'leaseUntil'
    | 'invoiceKey'
  >
> & { reason?: Reason; decidedBy?: DecidedBy; detail?: unknown };

export class TransitionNotAllowed extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(`transition ${from} -> ${to} is not allowed`);
    this.name = 'TransitionNotAllowed';
  }
}

export type StatusChange = {
  requestId: string;
  runId: string | null;
  /** Whose request: the feed shows an account token only its own account (Slice 12 part 2). */
  account: string;
  from: PaymentStatus | null;
  to: PaymentStatus;
  reason: Reason | null;
};

export class Store {
  private readonly listeners = new Set<(change: StatusChange) => void>();
  private readonly proposalListeners = new Set<(proposal: ProposalRow) => void>();

  constructor(private readonly db: Db) {}

  /** Calls `listener` after every committed status change (the live feed). Returns an unsubscribe function. */
  onChange(listener: (change: StatusChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Calls `listener` after each new proposal is stored (Slice 14's WhatsApp). Returns an unsubscribe function. */
  onProposal(listener: (proposal: ProposalRow) => void): () => void {
    this.proposalListeners.add(listener);
    return () => {
      this.proposalListeners.delete(listener);
    };
  }

  private emit(change: StatusChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (e) {
        console.error(`status listener: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Creates the request, or returns the one already there for the same id (a retry, or a
   * second agent with the same invoice). The first status and its event are one transaction.
   */
  async createRequest(r: NewRequest): Promise<{ request: PaymentRequestRow; created: boolean }> {
    const result = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(paymentRequests)
        .values({
          id: r.id,
          runId: r.runId ?? null,
          account: r.account,
          vault: r.vault,
          invoiceHash: r.invoiceHash,
          payTo: r.payTo,
          amount: r.amount.toString(),
          deadline: r.deadline,
          agentSig: r.agentSig,
          agentAddress: r.agentAddress ?? null,
          document: r.document ?? null,
          status: 'requested',
        })
        .onConflictDoNothing({ target: paymentRequests.id })
        .returning();
      const created = inserted[0];
      if (created) {
        await tx
          .insert(paymentEvents)
          .values({ requestId: created.id, fromStatus: null, toStatus: 'requested' });
        return { request: created, created: true };
      }
      const [existing] = await tx
        .select()
        .from(paymentRequests)
        .where(eq(paymentRequests.id, r.id));
      if (!existing) throw new Error(`request ${r.id} vanished during creation`);
      return { request: existing, created: false };
    });
    if (result.created) {
      this.emit({
        requestId: result.request.id,
        runId: result.request.runId,
        account: result.request.account,
        from: null,
        to: 'requested',
        reason: null,
      });
    }
    return result;
  }

  /** Throws if the database cannot be reached (health check). */
  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  async get(id: string): Promise<PaymentRequestRow | undefined> {
    const [row] = await this.db.select().from(paymentRequests).where(eq(paymentRequests.id, id));
    return row;
  }

  async events(id: string) {
    return this.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.requestId, id))
      .orderBy(asc(paymentEvents.id));
  }

  /**
   * Moves a request from `from` to `to`, only if it is still in `from` (another worker may
   * have moved it: then this returns false and changes nothing). The new status, the patch
   * and the event row are one transaction, so history and state never disagree. A transition
   * the state machine does not allow throws.
   */
  async transition(
    id: string,
    from: PaymentStatus,
    to: PaymentStatus,
    patch: TransitionPatch = {},
  ): Promise<boolean> {
    if (!canTransition(from, to)) throw new TransitionNotAllowed(from, to);
    const { reason, decidedBy, detail, ...fields } = patch;
    const moved = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(paymentRequests)
        .set({
          ...fields,
          status: to,
          ...(reason !== undefined ? { reason } : {}),
          ...(decidedBy !== undefined ? { decidedBy } : {}),
          leaseUntil: fields.leaseUntil ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(paymentRequests.id, id), eq(paymentRequests.status, from)))
        .returning({
          id: paymentRequests.id,
          runId: paymentRequests.runId,
          account: paymentRequests.account,
        });
      const row = updated[0];
      if (!row) return undefined;
      await tx.insert(paymentEvents).values({
        requestId: id,
        fromStatus: from,
        toStatus: to,
        reason: reason ?? null,
        detail: detail ?? null,
      });
      return { runId: row.runId, account: row.account };
    });
    if (moved === undefined) return false;
    this.emit({
      requestId: id,
      runId: moved.runId,
      account: moved.account,
      from,
      to,
      reason: reason ?? null,
    });
    return true;
  }

  /** Sets fields without changing the status (for example the transaction hash while settling). */
  async update(
    id: string,
    status: PaymentStatus,
    fields: Omit<TransitionPatch, 'reason' | 'decidedBy' | 'detail'>,
  ): Promise<boolean> {
    const updated = await this.db
      .update(paymentRequests)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(paymentRequests.id, id), eq(paymentRequests.status, status)))
      .returning({ id: paymentRequests.id });
    return updated.length > 0;
  }

  /**
   * Claims up to `limit` requests in `status` that no other worker holds, oldest first, and
   * leases them for `leaseMs`. `FOR UPDATE SKIP LOCKED` makes concurrent claims take disjoint
   * rows; the lease lets another worker take a request whose worker died.
   */
  async claim(
    status: PaymentStatus,
    limit: number,
    leaseMs: number,
    now: Date = new Date(),
  ): Promise<PaymentRequestRow[]> {
    const until = new Date(now.getTime() + leaseMs);
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: paymentRequests.id })
        .from(paymentRequests)
        .where(
          and(
            eq(paymentRequests.status, status),
            sql`(${paymentRequests.leaseUntil} is null or ${paymentRequests.leaseUntil} < ${now.toISOString()})`,
          ),
        )
        .orderBy(asc(paymentRequests.requestedAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (candidates.length === 0) return [];
      return tx
        .update(paymentRequests)
        .set({ leaseUntil: until })
        .where(
          inArray(
            paymentRequests.id,
            candidates.map((c) => c.id),
          ),
        )
        .returning();
    });
  }

  async listByStatus(status: PaymentStatus, limit: number): Promise<PaymentRequestRow[]> {
    return this.db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.status, status))
      .orderBy(asc(paymentRequests.requestedAt))
      .limit(limit);
  }

  /** Held payments past their deadline can no longer be paid (the vault refuses them): expire them. */
  async expireHeld(nowSeconds: number): Promise<number> {
    const due = await this.db
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(
        and(eq(paymentRequests.status, 'held'), sql`${paymentRequests.deadline} < ${nowSeconds}`),
      )
      .limit(500);
    let expired = 0;
    for (const { id } of due) {
      if (await this.transition(id, 'held', 'expired', { reason: 'expired', decidedBy: 'rule' }))
        expired++;
    }
    return expired;
  }

  /** Requests waiting to settle whose transaction is one of `hashes`. */
  async settlingByTx(hashes: readonly string[]): Promise<PaymentRequestRow[]> {
    if (hashes.length === 0) return [];
    return this.db
      .select()
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.status, 'settling'),
          inArray(
            paymentRequests.txHash,
            hashes.map((h) => h.toLowerCase()),
          ),
        ),
      );
  }

  /** Every request a run sent, including ones another run sent first (Slice 16). */
  async listRun(runId: string): Promise<PaymentRequestRow[]> {
    const rows = await this.db
      .select({ request: paymentRequests })
      .from(runRequests)
      .innerJoin(paymentRequests, eq(paymentRequests.id, runRequests.requestId))
      .where(eq(runRequests.runId, runId))
      .orderBy(asc(paymentRequests.requestedAt));
    return rows.map((r) => r.request);
  }

  /** Records the requests a run sent (the same request can be in several runs). */
  async addToRun(runId: string, requestIds: string[]): Promise<void> {
    if (requestIds.length === 0) return;
    await this.db
      .insert(runRequests)
      .values(requestIds.map((requestId) => ({ runId, requestId })))
      .onConflictDoNothing();
  }

  async getRun(id: string): Promise<RunRow | undefined> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id));
    return row;
  }

  /** An account's runs, newest first (Slice 16's run board). */
  async runsOf(account: string, limit = 20): Promise<RunRow[]> {
    return this.db
      .select()
      .from(runs)
      .where(sql`lower(${runs.account}) = ${account.toLowerCase()}`)
      .orderBy(desc(runs.createdAt))
      .limit(limit);
  }

  /** The payment already released with this key on the account (a look-alike's original), if any. */
  async releasedWithKey(
    account: string,
    invoiceKey: string,
  ): Promise<PaymentRequestRow | undefined> {
    const [row] = await this.db
      .select()
      .from(paymentRequests)
      .where(and(eq(paymentRequests.account, account), eq(paymentRequests.invoiceKey, invoiceKey)))
      .limit(1);
    return row;
  }

  /** An account's held payments, newest first: what waits for its owner (Slice 11's inbox). */
  async heldOf(account: string, limit = 200): Promise<PaymentRequestRow[]> {
    return this.db
      .select()
      .from(paymentRequests)
      .where(
        and(
          sql`lower(${paymentRequests.account}) = ${account.toLowerCase()}`,
          eq(paymentRequests.status, 'held'),
        ),
      )
      .orderBy(desc(paymentRequests.requestedAt))
      .limit(limit);
  }

  /** An account's proposals waiting for its owner, newest first (Slice 11's inbox). */
  async pendingProposalsOf(account: string, limit = 100): Promise<ProposalRow[]> {
    return this.db
      .select()
      .from(proposals)
      .where(
        and(
          sql`lower(${proposals.account}) = ${account.toLowerCase()}`,
          eq(proposals.status, 'pending'),
        ),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(limit);
  }

  /** An account's payment requests, newest first (Slice 18: its records). */
  async requestsOf(account: string, limit = 5_000): Promise<PaymentRequestRow[]> {
    return this.db
      .select()
      .from(paymentRequests)
      .where(sql`lower(${paymentRequests.account}) = ${account.toLowerCase()}`)
      .orderBy(desc(paymentRequests.requestedAt))
      .limit(limit);
  }

  async createRun(id: Hex, account: Address, size: number): Promise<boolean> {
    const inserted = await this.db
      .insert(runs)
      .values({ id, account, size })
      .onConflictDoNothing({ target: runs.id })
      .returning({ id: runs.id });
    return inserted.length > 0;
  }

  /**
   * Reserves a relayer's next nonce, signs with it and, when `requestId` is given, stores the
   * signed transaction on that released request, all in one database transaction: if anything
   * fails the nonce is not used, so a crash can never leave a gap that blocks the wallet.
   * The row lock on the relayer's nonce serialises concurrent signers for the same wallet.
   */
  async signWithNextNonce<T extends { raw: Hex; hash: Hex }>(
    address: Address,
    chainNonce: number,
    sign: (nonce: number) => Promise<T>,
    /** A payment's request id, or the purpose of a transaction that is not a payment. */
    attach?: string | { purpose: string },
  ): Promise<T & { nonce: number }> {
    const requestId = typeof attach === 'string' ? attach : undefined;
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<{ nonce: number }>(sql`
        insert into relayer_nonces (address, next_nonce) values (${address.toLowerCase()}, ${chainNonce + 1})
        on conflict (address) do update set next_nonce = greatest(relayer_nonces.next_nonce, ${chainNonce}) + 1
        returning next_nonce - 1 as nonce`);
      const row = result.rows[0];
      if (!row) throw new Error(`no nonce reserved for ${address}`);
      const signed = await sign(row.nonce);
      if (requestId !== undefined) {
        const attached = await tx
          .update(paymentRequests)
          .set({
            relayer: address,
            relayerNonce: row.nonce,
            rawTx: signed.raw,
            txHash: signed.hash,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(paymentRequests.id, requestId),
              eq(paymentRequests.status, 'released'),
              isNull(paymentRequests.rawTx),
            ),
          )
          .returning({ id: paymentRequests.id });
        if (attached.length === 0)
          throw new Error(`request ${requestId} is no longer waiting to be sent`);
      }
      if (typeof attach === 'object')
        await tx.insert(relayerTxs).values({
          hash: signed.hash,
          relayer: address,
          nonce: row.nonce,
          raw: signed.raw,
          purpose: attach.purpose,
        });
      return { ...signed, nonce: row.nonce };
    });
  }

  /**
   * The next nonce for a relayer, atomically: never below the chain's count (`chainNonce`,
   * the transactions it already confirmed), and never the same twice.
   */
  async reserveNonce(address: Address, chainNonce: number): Promise<number> {
    const result = await this.db.execute<{ nonce: number }>(sql`
      insert into relayer_nonces (address, next_nonce) values (${address.toLowerCase()}, ${chainNonce + 1})
      on conflict (address) do update set next_nonce = greatest(relayer_nonces.next_nonce, ${chainNonce}) + 1
      returning next_nonce - 1 as nonce`);
    const row = result.rows[0];
    if (!row) throw new Error(`no nonce reserved for ${address}`);
    // pg returns int4 as a JS number; next_nonce is int4.
    return row.nonce;
  }

  // ---------- ERC-8004 agents (Slice 19) ----------

  async upsertAgent(a: { agentId: string; registry: string; wallet: Address }): Promise<AgentRow> {
    const [row] = await this.db
      .insert(agents)
      .values(a)
      .onConflictDoUpdate({
        target: agents.agentId,
        set: { wallet: a.wallet, registry: a.registry },
      })
      .returning();
    if (!row) throw new Error(`agent ${a.agentId} was not stored`);
    return row;
  }

  async listAgents(): Promise<AgentRow[]> {
    return this.db.select().from(agents).orderBy(asc(agents.agentId));
  }

  // ---------- relayer transactions that are not payments ----------

  async pendingRelayerTxs(): Promise<RelayerTxRow[]> {
    return this.db
      .select()
      .from(relayerTxs)
      .where(isNull(relayerTxs.finalAt))
      .orderBy(asc(relayerTxs.createdAt));
  }

  /** The latest transaction for this purpose not yet final, if any. */
  async pendingRelayerTx(purpose: string): Promise<RelayerTxRow | undefined> {
    const [row] = await this.db
      .select()
      .from(relayerTxs)
      .where(and(eq(relayerTxs.purpose, purpose), isNull(relayerTxs.finalAt)))
      .orderBy(sql`${relayerTxs.createdAt} desc`)
      .limit(1);
    return row;
  }

  /** Those of these hashes that are relayer transactions still waiting to be final. */
  async pendingRelayerTxsByHash(hashes: string[]): Promise<RelayerTxRow[]> {
    if (hashes.length === 0) return [];
    return this.db
      .select()
      .from(relayerTxs)
      .where(and(inArray(sql`lower(${relayerTxs.hash})`, hashes), isNull(relayerTxs.finalAt)));
  }

  async markRelayerTxFinal(
    hash: string,
    status: 'success' | 'reverted',
    blockNumber?: number,
  ): Promise<void> {
    await this.db
      .update(relayerTxs)
      .set({ finalAt: new Date(), status, ...(blockNumber === undefined ? {} : { blockNumber }) })
      .where(and(eq(relayerTxs.hash, hash), isNull(relayerTxs.finalAt)));
  }

  /** The latest transaction for this purpose, final or not. */
  async relayerTxFor(purpose: string): Promise<RelayerTxRow | undefined> {
    const [row] = await this.db
      .select()
      .from(relayerTxs)
      .where(eq(relayerTxs.purpose, purpose))
      .orderBy(sql`${relayerTxs.createdAt} desc`)
      .limit(1);
    return row;
  }

  async relayerTx(hash: string): Promise<RelayerTxRow | undefined> {
    const [row] = await this.db
      .select()
      .from(relayerTxs)
      .where(sql`lower(${relayerTxs.hash}) = ${hash.toLowerCase()}`);
    return row;
  }

  // ---------- decisions recorded on Monad (Slice 18) ----------

  /** A decision to record; the same request's second decision by the same party changes nothing. */
  async addDecisionRecord(row: Omit<DecisionRecordRow, 'createdAt' | 'txHash'>): Promise<boolean> {
    const added = await this.db
      .insert(decisionRecords)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: decisionRecords.requestId });
    return added.length > 0;
  }

  async decisionRecord(
    requestId: string,
    decidedBy: 'checker' | 'owner',
  ): Promise<DecisionRecordRow | undefined> {
    const [row] = await this.db
      .select()
      .from(decisionRecords)
      .where(
        and(eq(decisionRecords.requestId, requestId), eq(decisionRecords.decidedBy, decidedBy)),
      );
    return row;
  }

  /** A payment's decisions to record, first first: the checker's hold, then the owner's refusal. */
  async decisionRecords(requestId: string): Promise<DecisionRecordRow[]> {
    return this.db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.requestId, requestId))
      .orderBy(asc(decisionRecords.createdAt));
  }

  async setDecisionTx(
    requestId: string,
    decidedBy: 'checker' | 'owner',
    txHash: string,
  ): Promise<void> {
    await this.db
      .update(decisionRecords)
      .set({ txHash })
      .where(
        and(
          eq(decisionRecords.requestId, requestId),
          eq(decisionRecords.decidedBy, decidedBy),
          isNull(decisionRecords.txHash),
        ),
      );
  }

  /** Decisions whose transaction was never signed (a restart, or recording switched off then). */
  async unsentDecisionRecords(): Promise<DecisionRecordRow[]> {
    return this.db
      .select()
      .from(decisionRecords)
      .where(isNull(decisionRecords.txHash))
      .orderBy(asc(decisionRecords.createdAt));
  }

  // ---------- judge mode's demo accounts (Slice 9 part 4) ----------

  async getDemoAccount(account: Address): Promise<DemoAccountRow | undefined> {
    const [row] = await this.db
      .select()
      .from(demoAccounts)
      .where(eq(demoAccounts.account, account));
    return row;
  }

  /** Records a new demo account as `creating`; recording it again returns the first record. */
  async createDemoAccount(input: {
    account: Address;
    qx: Hex;
    qy: Hex;
    plan: unknown;
  }): Promise<DemoAccountRow> {
    await this.db
      .insert(demoAccounts)
      .values({ ...input, status: 'creating' })
      .onConflictDoNothing();
    const row = await this.getDemoAccount(input.account);
    if (!row) throw new Error(`demo account ${input.account} was not recorded`);
    return row;
  }

  async setDemoStatus(account: Address, status: DemoStatus): Promise<DemoAccountRow> {
    const [row] = await this.db
      .update(demoAccounts)
      .set({ status, ...(status === 'ready' ? { readyAt: new Date() } : {}) })
      .where(eq(demoAccounts.account, account))
      .returning();
    if (!row) throw new Error(`no demo account ${account}`);
    return row;
  }

  /** How many demo accounts were created since then (the daily limit). */
  async demoAccountsSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(demoAccounts)
      .where(gt(demoAccounts.createdAt, since));
    return row?.n ?? 0;
  }

  // ---------- accounts and their orders (Slice 12) ----------

  /** Registers an account for indexing from `fromBlock`; registering it again changes nothing. */
  async registerAccount(address: Address, fromBlock: number, label?: string): Promise<AccountRow> {
    await this.db
      .insert(accounts)
      .values({ address, indexedTo: fromBlock - 1, label: label ?? null })
      .onConflictDoNothing();
    const [row] = await this.db.select().from(accounts).where(eq(accounts.address, address));
    if (!row) throw new Error(`account ${address} was not registered`);
    return row;
  }

  async listAccounts(): Promise<AccountRow[]> {
    return this.db.select().from(accounts).orderBy(asc(accounts.address));
  }

  /** Moves an account's indexed block forward, never back. */
  /**
   * Every account indexed up to the block before `block` is now indexed up to `block`, in one write
   * (Slice 16: one write per account per block fell behind Monad as accounts accumulated).
   */
  async advanceIndexed(block: number): Promise<void> {
    await this.db
      .update(accounts)
      .set({ indexedTo: block })
      .where(eq(accounts.indexedTo, block - 1));
  }

  async setIndexedTo(address: Address, block: number): Promise<void> {
    await this.db
      .update(accounts)
      .set({ indexedTo: block })
      .where(and(eq(accounts.address, address), lt(accounts.indexedTo, block)));
  }

  /** From an OrderApproved event; applying the same event twice changes nothing. */
  async upsertOrder(order: Omit<OrderRow, 'closed'>): Promise<void> {
    await this.db.insert(orders).values(order).onConflictDoNothing();
  }

  /**
   * What a vault has sent or paid, by the gateway's own count (Slice 16): every payment from a vault
   * goes through this gateway, so its order's room is its amount less this.
   */
  async vaultCommitted(vault: string): Promise<bigint> {
    const [row] = await this.db
      .select({ total: sql<string | null>`sum(${paymentRequests.amount})` })
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.vault, vault),
          inArray(paymentRequests.status, ['settling', 'settled']),
        ),
      );
    return BigInt(row?.total ?? '0');
  }

  async orderByVault(vault: string): Promise<OrderRow | undefined> {
    const [row] = await this.db.select().from(orders).where(eq(orders.vault, vault));
    return row;
  }

  /**
   * The approved proposal an order was opened from: its quote (the document whose hash is the
   * order's `orderHash`) and its supplier's name, for the checker (Slice 10).
   */
  async approvedQuote(
    account: string,
    documentHash: string,
  ): Promise<{ document: unknown; supplierName: string } | undefined> {
    const [row] = await this.db
      .select({ document: proposals.document, supplierName: proposals.supplierName })
      .from(proposals)
      .where(
        and(
          eq(proposals.account, account),
          eq(proposals.documentHash, documentHash),
          eq(proposals.status, 'approved'),
        ),
      )
      .limit(1);
    return row;
  }

  /** The suppliers an account's owner approved through proposals, by name. */
  async approvedSupplierNames(account: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: proposals.supplierName })
      .from(proposals)
      .where(and(eq(proposals.account, account), eq(proposals.status, 'approved')));
    return rows.map((r) => r.name);
  }

  async closeOrder(vault: Address): Promise<void> {
    await this.db.update(orders).set({ closed: true }).where(eq(orders.vault, vault));
  }

  /** Open orders: not closed, not expired. */
  async openOrders(account: Address, nowSeconds: number): Promise<OrderRow[]> {
    return this.db
      .select()
      .from(orders)
      .where(
        and(eq(orders.account, account), eq(orders.closed, false), gt(orders.expiry, nowSeconds)),
      )
      .orderBy(asc(orders.approvedBlock));
  }

  // ---------- proposals (Slice 12) ----------

  /** The same (account, document) is one proposal: the second call returns the first. */
  async createProposal(
    p: Omit<
      ProposalRow,
      | 'status'
      | 'createdAt'
      | 'decidedAt'
      | 'proofStatus'
      | 'proofUrl'
      | 'proofSource'
      | 'proofId'
      | 'proofError'
    > & { proofStatus?: 'checking' },
  ): Promise<{ proposal: ProposalRow; created: boolean }> {
    const inserted = await this.db
      .insert(proposals)
      .values({ ...p, status: 'pending' })
      .onConflictDoNothing()
      .returning();
    const first = inserted[0];
    if (first) {
      for (const listener of this.proposalListeners) {
        try {
          listener(first);
        } catch (e) {
          console.error(`proposal listener: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { proposal: first, created: true };
    }
    const existing = await this.getProposal(p.id);
    if (!existing) throw new Error(`proposal ${p.id} vanished`);
    return { proposal: existing, created: false };
  }

  async getProposal(id: string): Promise<ProposalRow | undefined> {
    const [row] = await this.db.select().from(proposals).where(eq(proposals.id, id));
    return row;
  }

  /** Moves a pending proposal to approved or refused; undefined if it was no longer pending. */
  async decideProposal(
    id: string,
    status: 'approved' | 'refused',
  ): Promise<ProposalRow | undefined> {
    const [row] = await this.db
      .update(proposals)
      .set({ status, decidedAt: new Date() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
      .returning();
    return row;
  }

  // ---------- owners' signatures (D36) ----------

  /** Keeps one owner's assertion for an action; the same owner signing again changes nothing. */
  async addOwnerSignature(row: {
    digest: Hex;
    qx: Hex;
    qy: Hex;
    account: Address;
    purpose: string;
    auth: unknown;
    detail?: unknown;
  }): Promise<void> {
    await this.db
      .insert(ownerSignatures)
      .values({
        digest: row.digest.toLowerCase(),
        qx: row.qx.toLowerCase(),
        qy: row.qy.toLowerCase(),
        account: row.account.toLowerCase(),
        purpose: row.purpose,
        auth: row.auth,
        detail: row.detail ?? null,
      })
      .onConflictDoNothing();
  }

  /** Every assertion gathered for this action, oldest first. */
  async ownerSignatures(digest: Hex): Promise<OwnerSignatureRow[]> {
    return this.db
      .select()
      .from(ownerSignatures)
      .where(eq(ownerSignatures.digest, digest.toLowerCase()))
      .orderBy(asc(ownerSignatures.createdAt));
  }

  /** Assertions gathered for an account's actions of one kind (pending unpause, owner changes). */
  async ownerSignaturesFor(account: Address, purpose: string): Promise<OwnerSignatureRow[]> {
    return this.db
      .select()
      .from(ownerSignatures)
      .where(
        and(
          eq(ownerSignatures.account, account.toLowerCase()),
          eq(ownerSignatures.purpose, purpose),
        ),
      )
      .orderBy(asc(ownerSignatures.createdAt));
  }

  // ---------- WhatsApp (Slice 14) ----------

  /** A new connect code for an account, not usable until an owner signs for it. */
  async createWhatsappLink(
    code: string,
    account: Address,
    expiresAt: Date,
    now: Date,
  ): Promise<void> {
    // Times come from the caller's clock, the one its hourly cap compares with.
    await this.db
      .insert(whatsappLinks)
      .values({ code, account: account.toLowerCase(), expiresAt, createdAt: now });
  }

  /** Codes issued for an account since `since` (a cap on how many anyone can ask for). */
  async whatsappLinksSince(account: Address, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(whatsappLinks)
      .where(
        and(eq(whatsappLinks.account, account.toLowerCase()), gte(whatsappLinks.createdAt, since)),
      );
    return row?.n ?? 0;
  }

  async whatsappLink(code: string) {
    const [row] = await this.db.select().from(whatsappLinks).where(eq(whatsappLinks.code, code));
    return row;
  }

  /** An owner signed for the code; false if it is unknown, expired or already signed. */
  async signWhatsappLink(code: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(whatsappLinks)
      .set({ signedAt: now })
      .where(
        and(
          eq(whatsappLinks.code, code),
          isNull(whatsappLinks.signedAt),
          gt(whatsappLinks.expiresAt, now),
        ),
      )
      .returning({ code: whatsappLinks.code });
    return rows.length === 1;
  }

  /**
   * Uses a signed, unexpired code once, connecting the number that sent it to the code's account.
   * The account, or undefined if the code is not usable.
   */
  async redeemWhatsappLink(code: string, waId: string, now: Date): Promise<string | undefined> {
    return this.db.transaction(async (tx) => {
      const [link] = await tx
        .update(whatsappLinks)
        .set({ usedAt: now })
        .where(
          and(
            eq(whatsappLinks.code, code),
            isNotNull(whatsappLinks.signedAt),
            isNull(whatsappLinks.usedAt),
            gt(whatsappLinks.expiresAt, now),
          ),
        )
        .returning({ account: whatsappLinks.account });
      if (!link) return undefined;
      await tx
        .insert(whatsappContacts)
        .values({ account: link.account, waId, connectedAt: now, lastInboundAt: now })
        .onConflictDoUpdate({
          target: [whatsappContacts.account, whatsappContacts.waId],
          set: { lastInboundAt: now },
        });
      return link.account;
    });
  }

  /** The person wrote to Countersign: WhatsApp's 24-hour window for free-form messages opens again. */
  async touchWhatsapp(waId: string, now: Date): Promise<number> {
    const rows = await this.db
      .update(whatsappContacts)
      .set({ lastInboundAt: now })
      .where(eq(whatsappContacts.waId, waId))
      .returning({ account: whatsappContacts.account });
    return rows.length;
  }

  /** STOP: the number is disconnected from every account. How many it was connected to. */
  async removeWhatsapp(waId: string): Promise<number> {
    const rows = await this.db
      .delete(whatsappContacts)
      .where(eq(whatsappContacts.waId, waId))
      .returning({ account: whatsappContacts.account });
    return rows.length;
  }

  async whatsappContacts(account: string): Promise<WhatsappContactRow[]> {
    return this.db
      .select()
      .from(whatsappContacts)
      .where(eq(whatsappContacts.account, account.toLowerCase()))
      .orderBy(asc(whatsappContacts.connectedAt));
  }

  /** Messages to a number since `since`, sent or not (the hourly cap). */
  async whatsappMessagesSince(waId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.waId, waId),
          gte(whatsappMessages.createdAt, since),
          inArray(whatsappMessages.status, ['sending', 'sent', 'delivered', 'read']),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Claims the one message about `subject` for this person, before it is sent: false if it was
   * claimed already (the same hold twice, or a second gateway process).
   */
  async claimWhatsappMessage(m: {
    subject: string;
    waId: string;
    account: string;
    kind: 'held' | 'proposal';
    now: Date;
  }): Promise<boolean> {
    const { now, ...rest } = m;
    const rows = await this.db
      .insert(whatsappMessages)
      .values({
        ...rest,
        account: m.account.toLowerCase(),
        status: 'sending',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ subject: whatsappMessages.subject });
    return rows.length === 1;
  }

  /** What became of a claimed message: sent (with WhatsApp's id), failed or skipped, and why. */
  async finishWhatsappMessage(
    subject: string,
    waId: string,
    result: {
      status: 'sent' | 'failed' | 'skipped';
      via?: 'link' | 'template';
      messageId?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.db
      .update(whatsappMessages)
      .set({
        status: result.status,
        via: result.via ?? null,
        messageId: result.messageId ?? null,
        error: result.error ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(whatsappMessages.subject, subject), eq(whatsappMessages.waId, waId)));
  }

  /**
   * A delivery status from WhatsApp's webhook. Statuses can arrive out of order, so a message only
   * moves forward (sent, delivered, read); failed always applies.
   */
  async whatsappDelivery(messageId: string, status: string, error?: string): Promise<void> {
    const order = ['sending', 'sent', 'delivered', 'read'];
    const rank = order.indexOf(status);
    if (status !== 'failed' && rank === -1) return;
    const earlier = status === 'failed' ? order : order.slice(0, rank);
    await this.db
      .update(whatsappMessages)
      .set({ status, error: error ?? null, updatedAt: new Date() })
      .where(
        and(eq(whatsappMessages.messageId, messageId), inArray(whatsappMessages.status, earlier)),
      );
  }

  async whatsappMessages(subject: string): Promise<WhatsappMessageRow[]> {
    return this.db
      .select()
      .from(whatsappMessages)
      .where(eq(whatsappMessages.subject, subject))
      .orderBy(asc(whatsappMessages.createdAt));
  }

  // ---------- account tokens (Slice 12 part 2) ----------

  /** The generation the account's next token gets: how many it has had. */
  async nextTokenGeneration(account: Address): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(apiTokens)
      .where(eq(apiTokens.account, account.toLowerCase()));
    return row?.n ?? 0;
  }

  /**
   * Stores a new token (its hash) and revokes the account's earlier ones, in one transaction.
   * False if this generation already has a token: the signature that asked for it was used.
   */
  async issueApiToken(account: Address, tokenHash: string, generation: number): Promise<boolean> {
    const owner = account.toLowerCase();
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(apiTokens)
        .values({ tokenHash, account: owner, generation })
        .onConflictDoNothing()
        .returning({ tokenHash: apiTokens.tokenHash });
      if (inserted.length === 0) return false;
      await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiTokens.account, owner),
            isNull(apiTokens.revokedAt),
            lt(apiTokens.generation, generation),
          ),
        );
      return true;
    });
  }

  /** The account a live token belongs to (lower case), or null. */
  async apiTokenAccount(tokenHash: string): Promise<string | null> {
    const [row] = await this.db
      .select({ account: apiTokens.account })
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)));
    return row?.account ?? null;
  }

  // ---------- website proofs (Slice 15) ----------

  async addWebsiteProof(row: {
    url: string;
    listed?: string | null;
    signedAt?: Date | null;
    proofHash?: string | null;
    txHash?: string | null;
    error?: ProofError | null;
    createdAt: Date;
  }): Promise<WebsiteProofRow> {
    const [added] = await this.db.insert(websiteProofs).values(row).returning();
    if (!added) throw new Error('website proof not stored');
    return added;
  }

  /** The newest check of a file URL. */
  async latestWebsiteProof(url: string): Promise<WebsiteProofRow | undefined> {
    const [row] = await this.db
      .select()
      .from(websiteProofs)
      .where(eq(websiteProofs.url, url))
      .orderBy(desc(websiteProofs.createdAt), desc(websiteProofs.id))
      .limit(1);
    return row;
  }

  /** The newest proven check of a file URL (a proof Primus signed and the registry recorded). */
  async latestProvenWebsiteProof(url: string): Promise<WebsiteProofRow | undefined> {
    const [row] = await this.db
      .select()
      .from(websiteProofs)
      .where(and(eq(websiteProofs.url, url), isNotNull(websiteProofs.proofHash)))
      .orderBy(desc(websiteProofs.createdAt), desc(websiteProofs.id))
      .limit(1);
    return row;
  }

  /** Whether a proven check of `url` before `before` showed it listing `address`. */
  async websiteListedBefore(url: string, address: string, before: Date): Promise<boolean> {
    const rows = await this.db
      .select({ listed: websiteProofs.listed })
      .from(websiteProofs)
      .where(
        and(
          eq(websiteProofs.url, url),
          isNotNull(websiteProofs.proofHash),
          lt(websiteProofs.createdAt, before),
        ),
      );
    return rows.some((r) => r.listed?.toLowerCase() === address.toLowerCase());
  }

  /** Every supplier website on file, once each. */
  async supplierWebsiteUrls(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ url: supplierWebsites.url }).from(supplierWebsites);
    return rows.map((r) => r.url);
  }

  async websiteProof(id: number): Promise<WebsiteProofRow | undefined> {
    const [row] = await this.db.select().from(websiteProofs).where(eq(websiteProofs.id, id));
    return row;
  }

  /** A proposal's website check has started, on this file. */
  async startProposalCheck(
    id: string,
    check: { url: string; source: 'on_file' | 'proposal' },
  ): Promise<void> {
    await this.db
      .update(proposals)
      .set({ proofStatus: 'checking', proofUrl: check.url, proofSource: check.source })
      .where(eq(proposals.id, id));
  }

  /**
   * A proposal's website check has ended: its proof, or why there is none. Only the first ending
   * counts (a late result after a timeout changes nothing), so the challenge stays fixed.
   */
  async finishProposalCheck(
    id: string,
    result: {
      proofId?: number;
      error?: ProofError;
      url?: string | null;
      source?: 'on_file' | 'proposal' | null;
    },
  ): Promise<boolean> {
    const updated = await this.db
      .update(proposals)
      .set({
        proofStatus: 'done',
        proofId: result.proofId ?? null,
        proofError: result.error ?? null,
        ...(result.url !== undefined ? { proofUrl: result.url } : {}),
        ...(result.source !== undefined ? { proofSource: result.source } : {}),
      })
      .where(
        and(
          eq(proposals.id, id),
          or(isNull(proposals.proofStatus), eq(proposals.proofStatus, 'checking')),
        ),
      )
      .returning({ id: proposals.id });
    return updated.length > 0;
  }

  // ---------- bank accounts on file and advice (Slice 17) ----------

  /** Whether the account has an order (open or not) with this supplier. */
  async hasSupplier(account: Address, supplier: Hex): Promise<boolean> {
    const [row] = await this.db
      .select({ vault: orders.vault })
      .from(orders)
      .where(
        and(
          sql`lower(${orders.account}) = ${account.toLowerCase()}`,
          sql`lower(${orders.supplierId}) = ${supplier.toLowerCase()}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** An owner put (or replaced) a supplier's bank account on file. */
  async setSupplierBank(row: Omit<SupplierBankRow, 'updatedAt'>): Promise<void> {
    const values = {
      ...row,
      account: row.account.toLowerCase(),
      supplierId: row.supplierId.toLowerCase(),
    };
    await this.db
      .insert(supplierBanks)
      .values(values)
      .onConflictDoUpdate({
        target: [supplierBanks.account, supplierBanks.supplierId],
        set: { ...values, updatedAt: new Date() },
      });
  }

  async supplierBank(account: Address, supplierId: Hex): Promise<SupplierBankRow | undefined> {
    const [row] = await this.db
      .select()
      .from(supplierBanks)
      .where(
        and(
          eq(supplierBanks.account, account.toLowerCase()),
          eq(supplierBanks.supplierId, supplierId.toLowerCase()),
        ),
      );
    return row;
  }

  async supplierBanksOf(account: Address): Promise<SupplierBankRow[]> {
    return this.db
      .select()
      .from(supplierBanks)
      .where(eq(supplierBanks.account, account.toLowerCase()));
  }

  /** The same invoice advised on twice is one record, updated with the latest advice. */
  async recordAdvice(row: Omit<AdviceCheckRow, 'createdAt'>): Promise<AdviceCheckRow> {
    const [saved] = await this.db
      .insert(adviceChecks)
      .values(row)
      .onConflictDoUpdate({
        target: adviceChecks.id,
        set: {
          advice: row.advice,
          reason: row.reason,
          evidence: row.evidence,
          createdAt: new Date(),
        },
      })
      .returning();
    if (!saved) throw new Error('advice not recorded');
    return saved;
  }

  async adviceById(id: string): Promise<AdviceCheckRow | undefined> {
    const [row] = await this.db.select().from(adviceChecks).where(eq(adviceChecks.id, id));
    return row;
  }

  async adviceOf(account: Address): Promise<AdviceCheckRow[]> {
    return this.db
      .select()
      .from(adviceChecks)
      .where(eq(adviceChecks.account, account.toLowerCase()))
      .orderBy(desc(adviceChecks.createdAt));
  }

  /** The website a supplier was approved with on this account (S15-4). */
  async supplierWebsite(account: Address, supplierId: Hex): Promise<string | undefined> {
    const [row] = await this.db
      .select({ url: supplierWebsites.url })
      .from(supplierWebsites)
      .where(
        and(
          eq(supplierWebsites.account, account.toLowerCase()),
          eq(supplierWebsites.supplierId, supplierId.toLowerCase()),
        ),
      );
    return row?.url;
  }

  async setSupplierWebsite(account: Address, supplierId: Hex, url: string): Promise<void> {
    await this.db
      .insert(supplierWebsites)
      .values({ account: account.toLowerCase(), supplierId: supplierId.toLowerCase(), url })
      .onConflictDoUpdate({
        target: [supplierWebsites.account, supplierWebsites.supplierId],
        set: { url, updatedAt: new Date() },
      });
  }
}
