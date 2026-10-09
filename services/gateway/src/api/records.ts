import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { formatUsdc, REASON_TEXT } from '@countersign/shared';
import { supplierNameOf } from '../suppliers.js';
import type { Store } from '../db/store.js';
import { paymentRecord, recordsCsv, type RecordDeps } from '../record.js';
import { mayUse, wrongAccount } from './account-tokens.js';
import { accountParam, apiError, requestIdParam } from './schemas.js';

/**
 * Slice 18's routes: a payment's record as one file, an account's records as one CSV, and a piece
 * of bank-transfer advice (Slice 17) by its id. All need a token: a record holds the invoice the
 * agent was given.
 */

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const errors = {
  401: json(apiError, 'Missing or wrong token'),
  403: json(apiError, 'An account token for another account (wrong_account)'),
};
const secured = [{ Bearer: [] }];

const getRecord = createRoute({
  method: 'get',
  path: '/v1/payments/{id}/record',
  tags: ['Payments'],
  summary: 'A payment’s record: one file an auditor can check against Monad',
  description:
    'countersign-record/1: the payment, the document as the agent gave it and its hash, the checks and the hash of their evidence, who decided and the decision on Monad (DecisionRecorded), the settlement (PaymentExecuted), every event and the timings, with how to verify each. Downloaded as countersign-record-<id>.json. `npx countersign-verify` checks it against Monad.',
  security: secured,
  request: { params: requestIdParam },
  responses: {
    200: json(z.looseObject({ format: z.literal('countersign-record/1') }), 'The record'),
    404: json(apiError, 'unknown_request'),
    ...errors,
  },
});

const getRecordsCsv = createRoute({
  method: 'get',
  path: '/v1/accounts/{account}/records.csv',
  tags: ['Payments'],
  summary: 'An account’s payments and bank-transfer advice as one CSV, newest first',
  description:
    'One row each: date, kind (payment or advice), id, invoice, supplier, amount, outcome, reason, who decided, evidence hash, the decision’s and the settlement’s transactions, and the link to its full record.',
  security: secured,
  request: { params: accountParam },
  responses: {
    200: { content: { 'text/csv': { schema: z.string() } }, description: 'The CSV' },
    ...errors,
  },
});

const getInbox = createRoute({
  method: 'get',
  path: '/v1/accounts/{account}/inbox',
  tags: ['Owner'],
  summary: 'What waits for the owner: held payments and proposals, newest first',
  description:
    'For the approver app (Slice 11): each held payment with its reason in plain words, and each pending proposal. Open one with GET /v1/approvals/{id}.',
  security: secured,
  request: { params: accountParam },
  responses: {
    200: json(
      z.object({
        account: z.string(),
        held: z.array(
          z.object({
            id: z.string(),
            amountUsdc: z.string(),
            payTo: z.string(),
            supplierName: z.string().nullable(),
            reason: z.string().nullable(),
            reasonText: z.string().nullable(),
            runId: z.string().nullable(),
            requestedAt: z.string(),
          }),
        ),
        proposals: z.array(
          z.object({
            id: z.string(),
            supplierName: z.string(),
            amountUsdc: z.string(),
            payTo: z.string(),
            createdAt: z.string(),
          }),
        ),
      }),
      'Waiting',
    ),
    ...errors,
  },
});

const getAdvice = createRoute({
  method: 'get',
  path: '/v1/advice/{id}',
  tags: ['Payments'],
  summary: 'A piece of advice on a bank-transfer invoice, with its evidence',
  security: secured,
  request: { params: requestIdParam },
  responses: {
    200: json(
      z.object({
        id: z.string(),
        account: z.string(),
        vault: z.string(),
        supplierId: z.string(),
        advice: z.string(),
        reason: z.string().nullable(),
        reasonText: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
        documentHash: z.string(),
        evidence: z.unknown(),
        checkedAt: z.string(),
      }),
      'The advice',
    ),
    404: json(apiError, 'unknown_advice'),
    ...errors,
  },
});

export function registerRecordRoutes(
  app: OpenAPIHono,
  deps: RecordDeps & {
    store: RecordDeps['store'] &
      Pick<
        Store,
        'get' | 'requestsOf' | 'adviceOf' | 'adviceById' | 'heldOf' | 'pendingProposalsOf'
      >;
  },
): void {
  app.openapi(getRecord, async (c) => {
    const { id } = c.req.valid('param');
    const row = await deps.store.get(id);
    // Another account's payment is unknown, not forbidden: its id says nothing (as for /v1/payments).
    if (!row || !mayUse(c, row.account)) return c.json({ error: 'unknown_request' }, 404);
    const record = await paymentRecord(deps, row);
    c.header('content-disposition', `attachment; filename="countersign-record-${row.id}.json"`);
    return c.json(record as { format: 'countersign-record/1' }, 200);
  });

  app.openapi(getRecordsCsv, async (c) => {
    const { account } = c.req.valid('param');
    if (!mayUse(c, account)) return c.json(wrongAccount, 403);
    const csv = await recordsCsv(
      deps,
      account,
      await deps.store.requestsOf(account),
      await deps.store.adviceOf(account),
    );
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="countersign-records-${account}.csv"`);
    return c.body(csv, 200);
  });

  app.openapi(getInbox, async (c) => {
    const { account } = c.req.valid('param');
    if (!mayUse(c, account)) return c.json(wrongAccount, 403);
    const names = new Map<string, string | null>();
    const held = [];
    for (const r of await deps.store.heldOf(account)) {
      if (!names.has(r.vault))
        names.set(r.vault, await supplierNameOf(deps.store, r.account, r.vault));
      held.push({
        id: r.id,
        amountUsdc: formatUsdc(BigInt(r.amount)),
        payTo: r.payTo,
        supplierName: names.get(r.vault) ?? null,
        reason: r.reason,
        reasonText: r.reason ? REASON_TEXT[r.reason] : null,
        runId: r.runId,
        requestedAt: r.requestedAt.toISOString(),
      });
    }
    const proposals = (await deps.store.pendingProposalsOf(account)).map((p) => ({
      id: p.id,
      supplierName: p.supplierName,
      amountUsdc: formatUsdc(BigInt(p.amount)),
      payTo: p.payTo,
      createdAt: p.createdAt.toISOString(),
    }));
    return c.json({ account, held, proposals }, 200);
  });

  app.openapi(getAdvice, async (c) => {
    const { id } = c.req.valid('param');
    const a = await deps.store.adviceById(id);
    if (!a || !mayUse(c, a.account)) return c.json({ error: 'unknown_advice' }, 404);
    return c.json(
      {
        id: a.id,
        account: a.account,
        vault: a.vault,
        supplierId: a.supplierId,
        advice: a.advice,
        reason: a.reason,
        reasonText: a.reason ? REASON_TEXT[a.reason] : null,
        invoiceNumber: a.invoiceNumber,
        documentHash: a.documentHash,
        evidence: a.evidence,
        checkedAt: a.createdAt.toISOString(),
      },
      200,
    );
  });
}
