import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { OUTCOME, PAYMENT_STATUSES } from '@countersign/shared';
import type { Chain, WebAuthnAuth } from './chain/types.js';
import type { PaymentRequestRow } from './db/schema.js';
import type { StatusChange, Store } from './db/store.js';
import { requestId, runId } from './ids.js';
import { paymentOf } from './payment.js';

export type AppDeps = {
  store: Store;
  chain: Pick<Chain, 'simulate' | 'verifyOwnerDecision'>;
  /** The service token the MCP server and the apps send (per-account sign-in comes in Slice 13). */
  token: string;
  /** Extra health details: relayer balances, the finality socket. */
  health: () => Promise<Record<string, unknown>>;
};

// ---------- request bodies (zod at every boundary) ----------

const hexBytes = (bytes: number) =>
  z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${String(bytes * 2)}}$`));
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((a) => getAddress(a));
const uint = z
  .union([z.string().regex(/^\d{1,78}$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));

const paymentBody = z.object({
  amount: z.string().regex(/^[1-9]\d{0,77}$/, 'a positive whole number of USDC base units'),
  invoiceHash: hexBytes(32),
  payTo: address,
  deadline: z.number().int().positive(),
});
const submission = z.object({
  vault: address,
  payment: paymentBody,
  agentSig: hexBytes(65),
  document: z.unknown().optional(),
});
const ownerAuthBody = z.object({
  r: hexBytes(32),
  s: hexBytes(32),
  challengeIndex: uint,
  typeIndex: uint,
  authenticatorData: z.string().regex(/^0x([0-9a-fA-F]{2}){37,}$/),
  clientDataJSON: z.string().min(1).max(4096),
});

type Issue = { path: readonly PropertyKey[]; message: string };

/** The validation error is typed and names the fields; it never echoes a stack trace. */
function invalid(
  result: { success: true } | { success: false; error: { issues: readonly Issue[] } },
): Response | undefined {
  if (result.success) return undefined;
  const issues = result.error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  return Response.json({ error: 'malformed', issues }, { status: 400 });
}

// ---------- views ----------

const ms = (a: Date | null, b: Date | null) => (a && b ? b.getTime() - a.getTime() : null);

export function viewOf(row: PaymentRequestRow) {
  return {
    id: row.id,
    runId: row.runId,
    status: row.status,
    reason: row.reason,
    decidedBy: row.decidedBy,
    account: row.account,
    vault: row.vault,
    payTo: row.payTo,
    amount: row.amount,
    invoiceHash: row.invoiceHash,
    deadline: row.deadline,
    evidence: row.evidence,
    tx: {
      hash: row.txHash,
      relayer: row.relayer,
      nonce: row.relayerNonce,
      block: row.blockNumber,
      proposedAt: row.proposedAt,
      votedAt: row.votedAt,
      finalizedAt: row.finalizedAt,
    },
    // Check time, the person's time and settlement time are kept apart; never summed into one claim.
    timings: {
      checkMs: ms(row.requestedAt, row.checkedAt),
      personMs: ms(row.checkedAt, row.decidedAt),
      settleMs: ms(row.sentAt, row.finalizedAt),
    },
  };
}

const toAuth = (a: z.output<typeof ownerAuthBody>): WebAuthnAuth => ({
  r: a.r as Hex,
  s: a.s as Hex,
  challengeIndex: a.challengeIndex,
  typeIndex: a.typeIndex,
  authenticatorData: a.authenticatorData as Hex,
  clientDataJSON: a.clientDataJSON,
});
/** Stored as JSON: bigints as strings. */
const storedAuth = (a: WebAuthnAuth) => ({
  ...a,
  challengeIndex: a.challengeIndex.toString(),
  typeIndex: a.typeIndex.toString(),
});

export function createApp(deps: AppDeps) {
  const { store, chain } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse(); // e.g. the token check's 401
    console.error(`gateway: ${err.message}`);
    return c.json({ error: 'internal' }, 500);
  });

  app.get('/health', async (c) => {
    const db = await store.ping().then(
      () => true,
      () => false,
    );
    const extra = await deps
      .health()
      .catch((e: unknown) => ({ healthError: e instanceof Error ? e.message : String(e) }));
    return c.json({ ok: db, db, ...extra }, db ? 200 : 503);
  });

  app.use(
    '/v1/*',
    bearerAuth({
      token: deps.token,
      noAuthenticationHeader: { message: { error: 'unauthorized' } },
      invalidAuthenticationHeader: { message: { error: 'unauthorized' } },
      invalidToken: { message: { error: 'unauthorized' } },
    }),
  );

  app.post(
    '/v1/payments',
    zValidator('json', submission.extend({ account: address }), invalid),
    async (c) => {
      const body = c.req.valid('json');
      const { request, created } = await store.createRequest({
        id: requestId(body.account, body.vault, body.payment.invoiceHash as Hex),
        account: body.account,
        vault: body.vault,
        invoiceHash: body.payment.invoiceHash as Hex,
        payTo: body.payment.payTo,
        amount: BigInt(body.payment.amount),
        deadline: body.payment.deadline,
        agentSig: body.agentSig as Hex,
        document: body.document,
      });
      return c.json({ created, request: viewOf(request) }, created ? 201 : 200);
    },
  );

  app.post(
    '/v1/runs',
    zValidator(
      'json',
      z.object({ account: address, payments: z.array(submission).min(1).max(500) }),
      invalid,
    ),
    async (c) => {
      const { account, payments } = c.req.valid('json');
      const ids = payments.map((p) => requestId(account, p.vault, p.payment.invoiceHash as Hex));
      const id = runId(account, ids);
      await store.createRun(id, account, payments.length);
      const requests = [];
      for (const [i, p] of payments.entries()) {
        const { request } = await store.createRequest({
          id: ids[i] as Hex,
          runId: id,
          account,
          vault: p.vault,
          invoiceHash: p.payment.invoiceHash as Hex,
          payTo: p.payment.payTo,
          amount: BigInt(p.payment.amount),
          deadline: p.payment.deadline,
          agentSig: p.agentSig as Hex,
          document: p.document,
        });
        requests.push({ id: request.id, status: request.status });
      }
      return c.json({ runId: id, requests }, 201);
    },
  );

  app.get('/v1/payments/:id', async (c) => {
    const row = await store.get(c.req.param('id'));
    return row ? c.json(viewOf(row)) : c.json({ error: 'unknown_request' }, 404);
  });

  app.get('/v1/runs/:id', async (c) => {
    const rows = await store.listRun(c.req.param('id'));
    if (rows.length === 0) return c.json({ error: 'unknown_run' }, 404);
    const byStatus = Object.fromEntries(
      PAYMENT_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]),
    );
    return c.json({
      runId: c.req.param('id'),
      size: rows.length,
      byStatus,
      requests: rows.map(viewOf),
    });
  });

  /** The owner pays a held payment once with the passkey. Simulated first: a bad signature costs nothing and changes nothing. */
  app.post(
    '/v1/payments/:id/approve',
    zValidator('json', z.object({ ownerAuth: ownerAuthBody }), invalid),
    async (c) => {
      const row = await store.get(c.req.param('id'));
      if (!row) return c.json({ error: 'unknown_request' }, 404);
      if (row.status !== 'held') return c.json({ error: 'not_held', status: row.status }, 409);
      const auth = toAuth(c.req.valid('json').ownerAuth);
      const refusal = await chain.simulate(row.vault as Address, paymentOf(row), {
        kind: 'payWithOwner',
        ownerAuth: auth,
      });
      if (refusal?.error === 'InvalidOwnerSignature')
        return c.json({ error: 'invalid_passkey' }, 422);
      if (refusal)
        return c.json(
          { error: 'contract_refuses', reason: refusal.reason, contract: refusal.error },
          409,
        );
      const moved = await store.transition(row.id, 'held', 'released', {
        ownerAuth: storedAuth(auth),
        decidedBy: 'user_once',
        decidedAt: new Date(),
      });
      if (!moved) return c.json({ error: 'not_held' }, 409);
      const after = await store.get(row.id);
      return c.json(after ? viewOf(after) : { id: row.id });
    },
  );

  /** The owner refuses a held payment with the passkey; a person's refusal ends the agent's run (money rule 7). */
  app.post(
    '/v1/payments/:id/refuse',
    zValidator(
      'json',
      z.object({
        ownerAuth: ownerAuthBody,
        decision: z.object({ reasonHash: hexBytes(32), evidenceHash: hexBytes(32) }),
      }),
      invalid,
    ),
    async (c) => {
      const row = await store.get(c.req.param('id'));
      if (!row) return c.json({ error: 'unknown_request' }, 404);
      if (row.status !== 'held') return c.json({ error: 'not_held', status: row.status }, 409);
      const { ownerAuth, decision } = c.req.valid('json');
      const auth = toAuth(ownerAuth);
      const signed = {
        invoiceHash: row.invoiceHash as Hex,
        outcome: OUTCOME.refused,
        reasonHash: decision.reasonHash as Hex,
        evidenceHash: decision.evidenceHash as Hex,
      };
      if (!(await chain.verifyOwnerDecision(row.vault as Address, signed, auth)))
        return c.json({ error: 'invalid_passkey' }, 422);
      const moved = await store.transition(row.id, 'held', 'refused', {
        reason: 'user_refused',
        decidedBy: 'user_refused',
        decidedAt: new Date(),
        ownerAuth: storedAuth(auth),
        detail: { decision },
      });
      if (!moved) return c.json({ error: 'not_held' }, 409);
      const after = await store.get(row.id);
      return c.json(after ? viewOf(after) : { id: row.id });
    },
  );

  /** Live status changes for the approver app and the run board. */
  app.get('/v1/feed', (c) =>
    streamSSE(c, async (stream) => {
      const queue: StatusChange[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = store.onChange((change) => {
        queue.push(change);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      let id = 0;
      // A function, so the compiler does not treat `aborted` as fixed across the awaits below.
      const open = () => !stream.aborted;
      try {
        while (open()) {
          const next = queue.shift();
          if (next) {
            await stream.writeSSE({
              event: 'status',
              id: String(++id),
              data: JSON.stringify(next),
            });
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 15_000); // a heartbeat comment keeps proxies from closing the stream
          });
          wake = undefined;
          if (queue.length === 0 && open()) await stream.write(': keep-alive\n\n');
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  return app;
}
