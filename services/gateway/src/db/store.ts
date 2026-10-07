import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
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
  demoAccounts,
  orders,
  paymentEvents,
  relayerTxs,
  paymentRequests,
  proposals,
  runs,
  type AccountRow,
  type DemoAccountRow,
  type DemoStatus,
  type OrderRow,
  type RelayerTxRow,
  type PaymentRequestRow,
  type ProposalRow,
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
  from: PaymentStatus | null;
  to: PaymentStatus;
  reason: Reason | null;
};

export class Store {
  private readonly listeners = new Set<(change: StatusChange) => void>();

  constructor(private readonly db: Db) {}

  /** Calls `listener` after every committed status change (the live feed). Returns an unsubscribe function. */
  onChange(listener: (change: StatusChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
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
        .returning({ id: paymentRequests.id, runId: paymentRequests.runId });
      const row = updated[0];
      if (!row) return undefined;
      await tx.insert(paymentEvents).values({
        requestId: id,
        fromStatus: from,
        toStatus: to,
        reason: reason ?? null,
        detail: detail ?? null,
      });
      return { runId: row.runId };
    });
    if (moved === undefined) return false;
    this.emit({ requestId: id, runId: moved.runId, from, to, reason: reason ?? null });
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

  async listRun(runId: string): Promise<PaymentRequestRow[]> {
    return this.db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.runId, runId))
      .orderBy(asc(paymentRequests.requestedAt));
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

  async markRelayerTxFinal(hash: string, status: 'success' | 'reverted'): Promise<void> {
    await this.db
      .update(relayerTxs)
      .set({ finalAt: new Date(), status })
      .where(and(eq(relayerTxs.hash, hash), isNull(relayerTxs.finalAt)));
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
    p: Omit<ProposalRow, 'status' | 'createdAt' | 'decidedAt'>,
  ): Promise<{ proposal: ProposalRow; created: boolean }> {
    const inserted = await this.db
      .insert(proposals)
      .values({ ...p, status: 'pending' })
      .onConflictDoNothing()
      .returning();
    const first = inserted[0];
    if (first) return { proposal: first, created: true };
    const existing = await this.getProposal(p.id);
    if (!existing) throw new Error(`proposal ${p.id} vanished`);
    return { proposal: existing, created: false };
  }

  async getProposal(id: string): Promise<ProposalRow | undefined> {
    const [row] = await this.db.select().from(proposals).where(eq(proposals.id, id));
    return row;
  }
}
