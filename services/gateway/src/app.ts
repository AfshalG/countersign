import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import type { Address, Hex } from 'viem';
import { OUTCOME, PAYMENT_STATUSES } from '@countersign/shared';
import type { Chain, WebAuthnAuth } from './chain/types.js';
import type { Checker } from './checker.js';
import { evaluate, SimulationUnavailable } from './pipeline/check.js';
import { registerOrderRoutes, type Indexing } from './api/orders.js';
import { paymentPage, proposalPage } from './api/status-page.js';
import { llmsFullTxt, llmsTxt } from './api/llms.js';
import type { PaymentRequestRow } from './db/schema.js';
import type { StatusChange, Store } from './db/store.js';
import { requestId, runId } from './ids.js';
import { paymentOf } from './payment.js';
import {
  address,
  apiError,
  bytes32,
  checkVerdict,
  created,
  ownerAuth,
  paymentView,
  requestIdParam,
  runCreated,
  runView,
  submission,
} from './api/schemas.js';

export type AppDeps = {
  store: Store;
  chain: Pick<Chain, 'simulate' | 'verifyOwnerDecision' | 'addressOnFile' | 'orderState'>;
  /** The order index (Slice 12); without it, registering an account answers 503. */
  indexing?: Indexing;
  /** Where people open status pages, e.g. https://gateway-production-e17a.up.railway.app. */
  publicUrl?: string;
  /** The checker and its time limit, for checks with no payment (POST /v1/checks). */
  checker: Checker;
  chainId: number;
  checkerTimeoutMs: number;
  /** The service token the MCP server and the apps send (per-account sign-in comes in Slice 13). */
  token: string;
  /** Extra health details: relayer balances, the finality socket. */
  health: () => Promise<Record<string, unknown>>;
};

// ---------- views ----------

const ms = (a: Date | null, b: Date | null) => (a && b ? b.getTime() - a.getTime() : null);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function viewOf(
  row: PaymentRequestRow,
  publicUrl = 'http://localhost:8787',
): z.infer<typeof paymentView> {
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
      proposedAt: iso(row.proposedAt),
      votedAt: iso(row.votedAt),
      finalizedAt: iso(row.finalizedAt),
    },
    // Check time, the person's time and settlement time are kept apart; never summed into one claim.
    timings: {
      checkMs: ms(row.requestedAt, row.checkedAt),
      personMs: ms(row.checkedAt, row.decidedAt),
      settleMs: ms(row.sentAt, row.finalizedAt),
    },
    statusUrl: `${publicUrl}/p/${row.id}`,
  };
}

const toAuth = (a: z.output<typeof ownerAuth>): WebAuthnAuth => ({
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

// ---------- routes (each one validated and documented from the same schemas) ----------

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const errors = {
  400: json(apiError, 'Malformed: the issues name each field'),
  401: json(apiError, 'Missing or wrong service token'),
};
const secured = [{ Bearer: [] }];

const submitPayment = createRoute({
  method: 'post',
  path: '/v1/payments',
  tags: ['Payments'],
  summary: 'Submit one invoice payment',
  description:
    'The same (account, vault, invoice) always returns the same request: safe to call twice. The request is checked, then settled, held or blocked; follow it with GET /v1/payments/{id} or the feed.',
  security: secured,
  request: {
    body: { content: { 'application/json': { schema: submission.extend({ account: address }) } } },
  },
  responses: {
    201: json(created, 'A new request'),
    200: json(created, 'The same invoice was submitted before: the first request'),
    ...errors,
  },
});

const submitRun = createRoute({
  method: 'post',
  path: '/v1/runs',
  tags: ['Payments'],
  summary: 'Submit a run of up to 500 invoice payments',
  security: secured,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ account: address, payments: z.array(submission).min(1).max(500) }),
        },
      },
    },
  },
  responses: { 201: json(runCreated, 'The run and each request’s first status'), ...errors },
});

const checkPayment = createRoute({
  method: 'post',
  path: '/v1/checks',
  tags: ['Payments'],
  summary: 'Check a payment without paying it',
  description:
    'The full check (the contract’s rules by simulation, then the checker) with nothing stored and nothing sent. For bank-transfer invoices (advice only) and dry runs. Never returns a signature.',
  security: secured,
  request: {
    body: { content: { 'application/json': { schema: submission.extend({ account: address }) } } },
  },
  responses: {
    200: json(checkVerdict, 'What would happen'),
    503: json(apiError, 'chain_unavailable: the chain could not be asked; nothing was decided'),
    ...errors,
  },
});

const getPayment = createRoute({
  method: 'get',
  path: '/v1/payments/{id}',
  tags: ['Payments'],
  summary: 'A payment request: status, reason, evidence, transaction and timings',
  security: secured,
  request: { params: requestIdParam },
  responses: {
    200: json(paymentView, 'The request'),
    404: json(apiError, 'unknown_request'),
    ...errors,
  },
});

const getRun = createRoute({
  method: 'get',
  path: '/v1/runs/{id}',
  tags: ['Payments'],
  summary: 'A run: counts by status and every request',
  security: secured,
  request: { params: requestIdParam },
  responses: { 200: json(runView, 'The run'), 404: json(apiError, 'unknown_run'), ...errors },
});

const approve = createRoute({
  method: 'post',
  path: '/v1/payments/{id}/approve',
  tags: ['Owner'],
  summary: 'Pay a held payment once with the owner’s passkey',
  description:
    'Simulated first: a wrong passkey costs nothing and changes nothing. The payment is sent through payWithOwner.',
  security: secured,
  request: {
    params: requestIdParam,
    body: { content: { 'application/json': { schema: z.object({ ownerAuth }) } } },
  },
  responses: {
    200: json(paymentView, 'Released; it settles like any other payment'),
    404: json(apiError, 'unknown_request'),
    409: json(apiError, 'not_held, or contract_refuses with the contract’s reason'),
    422: json(apiError, 'invalid_passkey'),
    ...errors,
  },
});

const refuse = createRoute({
  method: 'post',
  path: '/v1/payments/{id}/refuse',
  tags: ['Owner'],
  summary: 'Refuse a held payment with the owner’s passkey; this ends the agent’s run',
  security: secured,
  request: {
    params: requestIdParam,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            ownerAuth,
            decision: z.object({ reasonHash: bytes32, evidenceHash: bytes32 }),
          }),
        },
      },
    },
  },
  responses: {
    200: json(paymentView, 'Refused; nothing is sent'),
    404: json(apiError, 'unknown_request'),
    409: json(apiError, 'not_held'),
    422: json(apiError, 'invalid_passkey'),
    ...errors,
  },
});

const health = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Service'],
  summary: 'Database, the Monad finality socket and every relayer’s balance',
  responses: {
    200: json(z.looseObject({ ok: z.boolean(), db: z.boolean() }), 'Healthy'),
    503: json(z.looseObject({ ok: z.boolean(), db: z.boolean() }), 'The database is down'),
  },
});

export function createApp(deps: AppDeps) {
  const { store, chain } = deps;
  const publicUrl = (deps.publicUrl ?? 'http://localhost:8787').replace(/\/$/, '');
  const view = (row: PaymentRequestRow) => viewOf(row, publicUrl);
  const app = new OpenAPIHono({
    // One error shape for every validation failure: typed, naming each field, never a stack trace.
    defaultHook: (result, c) => {
      if (result.success) return undefined;
      const issues = result.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      }));
      return c.json({ error: 'malformed', issues }, 400);
    },
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse(); // e.g. the token check's 401
    console.error(`gateway: ${err.message}`);
    return c.json({ error: 'internal' }, 500);
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'The service token (per-account sign-in arrives in Slice 13)',
  });

  app.openapi(health, async (c) => {
    const db = await store.ping().then(
      () => true,
      () => false,
    );
    const extra = await deps
      .health()
      .catch((e: unknown) => ({ healthError: e instanceof Error ? e.message : String(e) }));
    return db ? c.json({ ok: true, db, ...extra }, 200) : c.json({ ok: false, db, ...extra }, 503);
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

  app.openapi(submitPayment, async (c) => {
    const body = c.req.valid('json');
    const { request, created: isNew } = await store.createRequest({
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
    const result = { created: isNew, request: view(request) };
    return isNew ? c.json(result, 201) : c.json(result, 200);
  });

  app.openapi(submitRun, async (c) => {
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
  });

  app.openapi(checkPayment, async (c) => {
    const body = c.req.valid('json');
    const now = new Date();
    // The same row shape a stored request has, so the check runs exactly as it would for real.
    const row: PaymentRequestRow = {
      id: requestId(body.account, body.vault, body.payment.invoiceHash as Hex),
      runId: null,
      account: body.account,
      vault: body.vault,
      invoiceHash: body.payment.invoiceHash,
      payTo: body.payment.payTo,
      amount: body.payment.amount,
      deadline: body.payment.deadline,
      agentSig: body.agentSig,
      document: body.document ?? null,
      status: 'checking',
      reason: null,
      decidedBy: null,
      evidence: null,
      checkerSig: null,
      ownerAuth: null,
      relayer: null,
      relayerNonce: null,
      rawTx: null,
      txHash: null,
      blockNumber: null,
      requestedAt: now,
      checkedAt: null,
      decidedAt: null,
      sentAt: null,
      proposedAt: null,
      votedAt: null,
      finalizedAt: null,
      updatedAt: now,
      leaseUntil: null,
    };
    try {
      const outcome = await evaluate(deps, row, { dryRun: true });
      return c.json(
        outcome.status === 'released'
          ? {
              verdict: 'would_settle' as const,
              reason: null,
              decidedBy: outcome.decidedBy,
              evidence: outcome.evidence,
            }
          : {
              verdict: outcome.status,
              reason: outcome.reason,
              decidedBy: outcome.decidedBy,
              evidence: outcome.evidence,
            },
        200,
      );
    } catch (e) {
      if (e instanceof SimulationUnavailable) return c.json({ error: 'chain_unavailable' }, 503);
      throw e;
    }
  });

  app.openapi(getPayment, async (c) => {
    const row = await store.get(c.req.valid('param').id);
    return row ? c.json(view(row), 200) : c.json({ error: 'unknown_request' }, 404);
  });

  app.openapi(getRun, async (c) => {
    const id = c.req.valid('param').id;
    const rows = await store.listRun(id);
    if (rows.length === 0) return c.json({ error: 'unknown_run' }, 404);
    const byStatus = Object.fromEntries(
      PAYMENT_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]),
    );
    return c.json({ runId: id, size: rows.length, byStatus, requests: rows.map(view) }, 200);
  });

  app.openapi(approve, async (c) => {
    const row = await store.get(c.req.valid('param').id);
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
    if (!after) return c.json({ error: 'unknown_request' }, 404);
    return c.json(view(after), 200);
  });

  /** A person's refusal ends the agent's run (money rule 7). */
  app.openapi(refuse, async (c) => {
    const row = await store.get(c.req.valid('param').id);
    if (!row) return c.json({ error: 'unknown_request' }, 404);
    if (row.status !== 'held') return c.json({ error: 'not_held', status: row.status }, 409);
    const body = c.req.valid('json');
    const auth = toAuth(body.ownerAuth);
    const signed = {
      invoiceHash: row.invoiceHash as Hex,
      outcome: OUTCOME.refused,
      reasonHash: body.decision.reasonHash as Hex,
      evidenceHash: body.decision.evidenceHash as Hex,
    };
    if (!(await chain.verifyOwnerDecision(row.vault as Address, signed, auth)))
      return c.json({ error: 'invalid_passkey' }, 422);
    const moved = await store.transition(row.id, 'held', 'refused', {
      reason: 'user_refused',
      decidedBy: 'user_refused',
      decidedAt: new Date(),
      ownerAuth: storedAuth(auth),
      detail: { decision: body.decision },
    });
    if (!moved) return c.json({ error: 'not_held' }, 409);
    const after = await store.get(row.id);
    if (!after) return c.json({ error: 'unknown_request' }, 404);
    return c.json(view(after), 200);
  });

  // The feed is Server-Sent Events, so it is documented here and served by a plain route below.
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/v1/feed',
    tags: ['Payments'],
    summary: 'Live status changes (Server-Sent Events, event "status")',
    security: secured,
    responses: {
      200: {
        description: 'One `status` event per change: { requestId, runId, from, to, reason }',
        content: { 'text/event-stream': { schema: z.string() } },
      },
    },
  });

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

  registerOrderRoutes(app, { store, chain, indexing: deps.indexing, publicUrl });

  // A page a person can open from an agent's message; public, like the link in the message.
  app.get('/p/:id', async (c) => {
    const id = c.req.param('id');
    const request = await store.get(id);
    if (request) return c.html(paymentPage(request));
    const proposal = await store.getProposal(id);
    if (proposal) return c.html(proposalPage(proposal));
    return c.html('<!doctype html><title>Not found</title><p>Nothing with that id.</p>', 404);
  });

  // The reference: the document and a page that renders it. Both are public, like any API docs.
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Countersign gateway',
      version: '0.1.0',
      description:
        'Payment requests from AI agents, checked against the owner’s rules, settled on Monad. The account contract on chain is the security boundary: it pays only suppliers on file, within approved orders. Testnet (chain 10143).',
    },
  });
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'Countersign gateway API' }));
  // For coding agents (llmstxt.org): the index, and the guides in one file.
  const markdown = { 'content-type': 'text/markdown; charset=utf-8' };
  app.get('/llms.txt', (c) => c.body(llmsTxt(publicUrl), 200, markdown));
  app.get('/llms-full.txt', async (c) => c.body(await llmsFullTxt(publicUrl), 200, markdown));
  // The bare address is the reference, not a 404.
  app.get('/', (c) => c.redirect('/docs'));

  return app;
}
