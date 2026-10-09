import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import type { Address, Hex } from 'viem';
import { REASONS } from '@countersign/shared';
import { advise, ADVICE_BUDGET_MS } from './advise.js';
import { check, CHECKER, BUDGET_MS } from './check.js';
import type { Model } from './model.js';
import type { Signer } from './sign.js';

/**
 * The checker's HTTP API (Slice 10, D33): what any checker answers, so anyone can run one; the
 * owner chooses the checker key in the account's policy. This service is the reference.
 */

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const page = z
  .object({
    html: z.string().max(512_000).optional(),
    text: z.string().max(512_000).optional(),
  })
  .refine((d) => d.html !== undefined || d.text !== undefined, { message: 'give html or text' });

const checkRequest = z
  .object({
    payment: z.object({
      chainId: z.number().int(),
      vault: address,
      amount: z
        .string()
        .regex(/^[0-9]{1,78}$/)
        .openapi({ description: 'USDC base units' }),
      invoiceHash: bytes32,
      payTo: address,
      deadline: z.union([z.number().int(), z.string().regex(/^[0-9]{1,20}$/)]),
    }),
    order: z.object({
      supplierId: bytes32,
      supplierName: z.string().max(200).nullable(),
      addressOnFile: address,
      quote: page.nullable().openapi({ description: 'The quote the owner approved, if known' }),
    }),
    invoice: page.openapi({ description: 'The invoice as the agent was given it' }),
    dryRun: z.boolean().optional(),
  })
  .openapi('CheckRequest');

const checkResponse = z
  .object({
    verdict: z.enum(['release', 'hold']),
    reason: z.enum(REASONS).optional(),
    checkerSig: z.string().optional().openapi({
      description: "The checker's EIP-712 signature of the vault's Payment ('0x' on a dry run)",
    }),
    decision: z
      .object({
        invoiceHash: bytes32,
        outcome: z.number().int(),
        reasonHash: bytes32,
        evidenceHash: bytes32,
        sig: z.string(),
      })
      .optional()
      .openapi({
        description:
          "A hold as the vault's EIP-712 Decision, signed with the checker key, for recordDecision on Monad (Slice 18). evidenceHash is keccak256 of the evidence as canonical JSON. None on a dry run",
      }),
    evidence: z.unknown(),
  })
  .openapi('CheckResponse');

const orderFacts = z.object({
  supplierId: bytes32,
  supplierName: z.string().max(200).nullable(),
  addressOnFile: address,
  quote: page.nullable().openapi({ description: 'The quote the owner approved, if known' }),
});

/** The supplier's bank account as the owner approved it (Slice 17). */
const bankOnFile = z
  .object({
    holder: z.string().min(1).max(200),
    iban: z.string().max(42).optional(),
    bic: z.string().max(11).optional(),
    sortCode: z.string().max(8).optional(),
    accountNumber: z.string().max(20).optional(),
    routingNumber: z.string().max(9).optional(),
  })
  .refine((b) => b.iban !== undefined || b.accountNumber !== undefined, {
    message: 'give an IBAN or an account number',
  })
  .openapi('BankOnFile');

const adviseRequest = z
  .object({
    order: orderFacts,
    bankOnFile: bankOnFile.nullable(),
    invoice: page.openapi({ description: 'The bank-transfer invoice as the agent was given it' }),
  })
  .openapi('AdviseRequest');

const adviseResponse = z
  .object({
    advice: z.enum(['match', 'mismatch', 'unsure']),
    reason: z.enum(REASONS).optional(),
    evidence: z.unknown(),
  })
  .openapi('AdviseResponse');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const apiError = z.object({ error: z.string() });

const checkRoute = createRoute({
  method: 'post',
  path: '/v1/check',
  summary: 'Check one payment against its invoice and order',
  description: `Answers within ${String(BUDGET_MS)} ms. Release only when every code check passed and no model answer held it; anything else, an error or a timeout included, is a hold.`,
  security: [{ Bearer: [] }],
  request: { body: { content: { 'application/json': { schema: checkRequest } } } },
  responses: {
    200: json(checkResponse, 'The verdict, with its evidence'),
    400: json(apiError, 'malformed'),
    401: json(apiError, 'unauthorized'),
  },
});

const adviseRoute = createRoute({
  method: 'post',
  path: '/v1/advise',
  summary: 'Advice on an invoice paid by bank transfer',
  description: `A bank transfer cannot be stopped from outside the bank, so this answers match, mismatch or unsure, with the evidence, and never signs (Slice 17). The invoice's bank account is compared with the one on file in code; the model is asked only when code found nothing definite, within ${String(ADVICE_BUDGET_MS)} ms. Optional for a checker: the gateway's \`/v1/advice\` needs it.`,
  security: [{ Bearer: [] }],
  request: { body: { content: { 'application/json': { schema: adviseRequest } } } },
  responses: {
    200: json(adviseResponse, 'The advice, with its evidence'),
    400: json(apiError, 'malformed'),
    401: json(apiError, 'unauthorized'),
  },
});

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  summary: 'The checker, its signing key and its model',
  responses: {
    200: json(
      z.object({ ok: z.boolean(), checker: z.string(), signer: z.string(), model: z.string() }),
      'Up',
    ),
  },
});

export function createApp(deps: { token: string; model: Model; signer: Signer }) {
  const app = new OpenAPIHono({
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
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`checker: ${err.message}`);
    return c.json({ error: 'internal' }, 500);
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
    type: 'http',
    scheme: 'bearer',
    description: "The caller's token (the gateway's)",
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

  app.openapi(healthRoute, (c) =>
    c.json(
      { ok: true, checker: CHECKER, signer: deps.signer.address, model: deps.model.name },
      200,
    ),
  );

  app.openapi(checkRoute, async (c) => {
    const b = c.req.valid('json');
    const pageOf = (p: { html?: string | undefined; text?: string | undefined }) =>
      p.html !== undefined ? { html: p.html } : { text: p.text ?? '' };
    const outcome = await check(
      {
        payment: {
          chainId: b.payment.chainId,
          vault: b.payment.vault as Address,
          amount: BigInt(b.payment.amount),
          invoiceHash: b.payment.invoiceHash as Hex,
          payTo: b.payment.payTo as Address,
          deadline: BigInt(b.payment.deadline),
        },
        order: {
          supplierId: b.order.supplierId as Hex,
          supplierName: b.order.supplierName,
          addressOnFile: b.order.addressOnFile as Address,
          quote: b.order.quote ? pageOf(b.order.quote) : null,
        },
        invoice: pageOf(b.invoice),
        ...(b.dryRun === undefined ? {} : { dryRun: b.dryRun }),
      },
      { model: deps.model, signer: deps.signer },
    );
    return c.json(outcome, 200);
  });

  app.openapi(adviseRoute, async (c) => {
    const b = c.req.valid('json');
    const pageOf = (p: { html?: string | undefined; text?: string | undefined }) =>
      p.html !== undefined ? { html: p.html } : { text: p.text ?? '' };
    const onFile = b.bankOnFile;
    const outcome = await advise(
      {
        order: {
          supplierId: b.order.supplierId as Hex,
          supplierName: b.order.supplierName,
          addressOnFile: b.order.addressOnFile as Address,
          quote: b.order.quote ? pageOf(b.order.quote) : null,
        },
        bankOnFile: onFile
          ? {
              holder: onFile.holder,
              ...(onFile.iban === undefined ? {} : { iban: onFile.iban }),
              ...(onFile.bic === undefined ? {} : { bic: onFile.bic }),
              ...(onFile.sortCode === undefined ? {} : { sortCode: onFile.sortCode }),
              ...(onFile.accountNumber === undefined
                ? {}
                : { accountNumber: onFile.accountNumber }),
              ...(onFile.routingNumber === undefined
                ? {}
                : { routingNumber: onFile.routingNumber }),
            }
          : null,
        invoice: pageOf(b.invoice),
      },
      { model: deps.model },
    );
    return c.json(outcome, 200);
  });

  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Countersign checker',
      version: CHECKER,
      description:
        'The second signature on an agent payment: reads the invoice, compares it with the order, signs only when everything passes (Slice 10).',
    },
  });
  return app;
}
