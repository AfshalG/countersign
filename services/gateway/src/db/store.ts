import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import {
  canTransition,
  type DecidedBy,
  type PaymentStatus,
  type Reason,
} from '@countersign/shared';
import type { Db } from './client.js';
import { paymentEvents, paymentRequests, runs, type PaymentRequestRow } from './schema.js';

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
  >
> & { reason?: Reason; decidedBy?: DecidedBy; detail?: unknown };

export class TransitionNotAllowed extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(`transition ${from} -> ${to} is not allowed`);
    this.name = 'TransitionNotAllowed';
  }
}

export class Store {
  constructor(private readonly db: Db) {}

  /**
   * Creates the request, or returns the one already there for the same id (a retry, or a
   * second agent with the same invoice). The first status and its event are one transaction.
   */
  async createRequest(r: NewRequest): Promise<{ request: PaymentRequestRow; created: boolean }> {
    return this.db.transaction(async (tx) => {
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
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(paymentRequests)
        .set({
          ...fields,
          status: to,
          ...(reason !== undefined ? { reason } : {}),
          ...(decidedBy !== undefined ? { decidedBy } : {}),
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(and(eq(paymentRequests.id, id), eq(paymentRequests.status, from)))
        .returning({ id: paymentRequests.id });
      if (updated.length === 0) return false;
      await tx.insert(paymentEvents).values({
        requestId: id,
        fromStatus: from,
        toStatus: to,
        reason: reason ?? null,
        detail: detail ?? null,
      });
      return true;
    });
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
}
