import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Address, Hex } from 'viem';
import { REASON_TEXT, REASONS } from '@countersign/shared';
import {
  adviceSaid,
  adviseOn,
  bankChallenge,
  bankOf,
  describeBank,
  InvalidBankError,
  normalBank,
  UnknownOrderError,
  type Advisor,
  type BankDetails,
} from '../advice.js';
import type { Chain } from '../chain/types.js';
import type { Store } from '../db/store.js';
import { ownerSigOf, storedSigs } from '../owner/signers.js';
import { mayUse, wrongAccount } from './account-tokens.js';
import { assertion } from './approvals.js';
import { accountParam, address, apiError, bytes32 } from './schemas.js';
import { AssertionError, fromBrowser } from './webauthn.js';

/**
 * Slice 17's routes. `POST /v1/advice` (a token: the agent asks) and the owner's bank accounts on
 * file (`/v1/owner/{account}/banks`: no token, any origin, the owner's passkey is the
 * authorisation, like the stop button's and the approvals' routes).
 */

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const errors = {
  400: json(apiError, 'Malformed: the issues name each field'),
  401: json(apiError, 'Missing or wrong token'),
  403: json(apiError, 'An account token for another account (wrong_account)'),
};
const secured = [{ Bearer: [] }];

const document = z
  .union([
    z.string().min(1).max(512_000),
    z.object({ html: z.string().min(1).max(512_000) }),
    z.object({ text: z.string().min(1).max(512_000) }),
  ])
  .openapi({
    description: 'The invoice as the agent was given it: its page ({ html }) or its text',
  });

const bankDetails = z
  .object({
    holder: z.string().min(1).max(200),
    iban: z.string().max(42).optional(),
    bic: z.string().max(14).optional(),
    sortCode: z.string().max(10).optional(),
    accountNumber: z.string().max(24).optional(),
    routingNumber: z.string().max(12).optional(),
  })
  .refine((b) => b.iban !== undefined || b.accountNumber !== undefined, {
    message: 'give an IBAN, or an account number',
  })
  .openapi('BankAccount', {
    description:
      'An IBAN (with its BIC), or an account number with a UK sort code or a US routing number',
  });

const onFileView = z
  .object({
    source: z.enum(['on_file', 'demo']).openapi({
      description: "on_file: an owner put it there with their passkey; demo: the demo supplier's",
    }),
    holder: z.string(),
    iban: z.string().optional(),
    bic: z.string().optional(),
    sortCode: z.string().optional(),
    accountNumber: z.string().optional(),
    routingNumber: z.string().optional(),
    description: z.string(),
  })
  .nullable();

const adviceView = z
  .object({
    id: z.string(),
    advice: z.enum(['match', 'mismatch', 'unsure']),
    reason: z.enum(REASONS).nullable(),
    reasonText: z.string().nullable(),
    said: z.string().openapi({ description: 'What to tell a person, always as advice' }),
    invoiceNumber: z.string().nullable(),
    onFile: onFileView,
    evidence: z.unknown(),
    checkedAt: z.string(),
  })
  .openapi('Advice');

const askAdvice = createRoute({
  method: 'post',
  path: '/v1/advice',
  tags: ['Payments'],
  summary: 'Advice on an invoice paid by bank transfer',
  description:
    'A bank transfer happens inside the bank, so Countersign cannot stop one: this answers match, mismatch or unsure, with the evidence. The checker reads the invoice, compares its bank account with the account on file for the order’s supplier, and runs the same checks as for a USDC invoice. Nothing is paid, no payment request is made; the advice is kept for the payment record.',
  security: secured,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            account: address,
            vault: address.openapi({ description: 'The order the invoice is against' }),
            document,
          }),
        },
      },
    },
  },
  responses: {
    200: json(adviceView, 'The advice'),
    404: json(apiError, 'unknown_order'),
    503: json(apiError, 'advice_unavailable, or chain_unavailable'),
    ...errors,
  },
});

const listBanks = createRoute({
  method: 'get',
  path: '/v1/accounts/{account}/banks',
  tags: ['Orders'],
  summary: 'The suppliers’ bank accounts on file',
  security: secured,
  request: { params: accountParam },
  responses: {
    200: json(
      z.object({
        account: z.string(),
        banks: z.array(
          z.object({
            supplierId: z.string(),
            holder: z.string(),
            iban: z.string().nullable(),
            bic: z.string().nullable(),
            sortCode: z.string().nullable(),
            accountNumber: z.string().nullable(),
            routingNumber: z.string().nullable(),
            description: z.string(),
            updatedAt: z.string(),
          }),
        ),
      }),
      'On file',
    ),
    ...errors,
  },
});

const bankBody = z.object({ supplierId: bytes32, bank: bankDetails });

const previewBank = createRoute({
  method: 'post',
  path: '/v1/owner/{account}/banks/preview',
  tags: ['Owner'],
  summary: 'What an owner signs to put a supplier’s bank account on file',
  request: {
    params: accountParam,
    body: { content: { 'application/json': { schema: bankBody } } },
  },
  responses: {
    200: json(
      z.object({
        challenge: z.string().openapi({ description: 'What one owner’s passkey signs' }),
        bank: bankDetails,
        summary: z.string(),
      }),
      'To sign',
    ),
    400: json(apiError, 'malformed'),
    404: json(apiError, 'unknown_supplier: the account has no order with this supplier'),
    422: json(apiError, 'invalid_bank: check digits fail, or a field is not well formed'),
  },
});

const putBank = createRoute({
  method: 'post',
  path: '/v1/owner/{account}/banks',
  tags: ['Owner'],
  summary: 'Put a supplier’s bank account on file, with one owner’s passkey',
  description:
    'Any one owner signs the challenge from the preview. Bank-transfer invoices are compared with this account (advice only). Replaces an account already on file.',
  request: {
    params: accountParam,
    body: {
      content: { 'application/json': { schema: bankBody.extend({ assertion }) } },
    },
  },
  responses: {
    200: json(
      z.object({ account: z.string(), supplierId: z.string(), bank: bankDetails }),
      'On file',
    ),
    400: json(apiError, 'malformed or malformed_assertion'),
    404: json(apiError, 'unknown_supplier'),
    422: json(apiError, 'invalid_bank, challenge_mismatch or invalid_passkey'),
  },
});

export type AdviceRouteDeps = {
  store: Pick<
    Store,
    | 'orderByVault'
    | 'approvedQuote'
    | 'supplierBank'
    | 'recordAdvice'
    | 'supplierBanksOf'
    | 'setSupplierBank'
    | 'hasSupplier'
  >;
  chain: Pick<Chain, 'addressOnFile' | 'ownership'>;
  chainId: number;
  advisor?: Advisor;
};

export function registerAdviceRoutes(app: OpenAPIHono, deps: AdviceRouteDeps): void {
  app.openapi(askAdvice, async (c) => {
    const body = c.req.valid('json');
    if (!mayUse(c, body.account)) return c.json(wrongAccount, 403);
    if (!deps.advisor)
      return c.json(
        { error: 'advice_unavailable', message: 'this gateway’s checker gives no advice' },
        503,
      );
    let out;
    try {
      out = await adviseOn(
        { ...deps, advisor: deps.advisor },
        {
          account: body.account,
          vault: body.vault,
          document: body.document,
        },
      );
    } catch (e) {
      if (e instanceof UnknownOrderError)
        return c.json({ error: 'unknown_order', message: e.message }, 404);
      console.error(`advice: ${e instanceof Error ? e.message : String(e)}`);
      return c.json(
        {
          error: 'chain_unavailable',
          message: 'the chain could not be asked; nothing was advised',
        },
        503,
      );
    }
    const { row, onFile } = out;
    return c.json(
      {
        id: row.id,
        advice: row.advice,
        reason: row.reason,
        reasonText: row.reason ? REASON_TEXT[row.reason] : null,
        said: adviceSaid(row.advice, row.reason),
        invoiceNumber: row.invoiceNumber,
        onFile: onFile ? { ...onFile, description: describeBank(onFile) } : null,
        evidence: row.evidence,
        checkedAt: row.createdAt.toISOString(),
      },
      200,
    );
  });

  app.openapi(listBanks, async (c) => {
    const { account } = c.req.valid('param');
    if (!mayUse(c, account)) return c.json(wrongAccount, 403);
    const rows = await deps.store.supplierBanksOf(account);
    return c.json(
      {
        account,
        banks: rows.map((r) => ({
          supplierId: r.supplierId,
          holder: r.holder,
          iban: r.iban,
          bic: r.bic,
          sortCode: r.sortCode,
          accountNumber: r.accountNumber,
          routingNumber: r.routingNumber,
          description: describeBank(bankOf(r)),
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
      200,
    );
  });

  /** The details in one normal form, for a supplier this account has an order with. */
  const checked = async (account: Address, supplier: Hex, given: z.infer<typeof bankDetails>) => {
    if (!(await deps.store.hasSupplier(account, supplier)))
      return { error: 'unknown_supplier' as const };
    try {
      const bank = normalBank(given as BankDetails);
      return { bank, challenge: bankChallenge(deps.chainId, account, supplier, bank) };
    } catch (e) {
      if (e instanceof InvalidBankError)
        return { error: 'invalid_bank' as const, message: e.message };
      throw e;
    }
  };

  app.openapi(previewBank, async (c) => {
    const { account } = c.req.valid('param');
    const body = c.req.valid('json');
    const out = await checked(account, body.supplierId as Hex, body.bank);
    if ('error' in out)
      return out.error === 'unknown_supplier'
        ? c.json({ error: out.error, message: 'this account has no order with that supplier' }, 404)
        : c.json({ error: out.error, message: out.message }, 422);
    return c.json(
      {
        challenge: out.challenge,
        bank: out.bank,
        summary: `Put this bank account on file for the supplier: ${describeBank(out.bank)}. Bank-transfer invoices from them are compared with it (advice only: nothing is paid).`,
      },
      200,
    );
  });

  app.openapi(putBank, async (c) => {
    const { account } = c.req.valid('param');
    const body = c.req.valid('json');
    const out = await checked(account, body.supplierId as Hex, body.bank);
    if ('error' in out)
      return out.error === 'unknown_supplier'
        ? c.json({ error: out.error, message: 'this account has no order with that supplier' }, 404)
        : c.json({ error: out.error, message: out.message }, 422);
    let auth;
    try {
      auth = fromBrowser(body.assertion, out.challenge);
    } catch (e) {
      if (!(e instanceof AssertionError)) throw e;
      return c.json(
        {
          error: e.code,
          message:
            e.code === 'challenge_mismatch'
              ? 'the signature is over other details; preview these and sign again'
              : e.message,
        },
        e.code === 'challenge_mismatch' ? 422 : 400,
      );
    }
    // Off chain, like refusing a proposal: no money moves. Any one owner (D36).
    const sig = await ownerSigOf(deps.chain, account, auth, true);
    if (!sig)
      return c.json({ error: 'invalid_passkey', message: 'not this account’s passkey' }, 422);
    await deps.store.setSupplierBank({
      account,
      supplierId: body.supplierId,
      holder: out.bank.holder,
      iban: out.bank.iban ?? null,
      bic: out.bank.bic ?? null,
      sortCode: out.bank.sortCode ?? null,
      accountNumber: out.bank.accountNumber ?? null,
      routingNumber: out.bank.routingNumber ?? null,
      ownerAuth: { challenge: out.challenge, sigs: storedSigs([sig]) },
    });
    return c.json({ account, supplierId: body.supplierId, bank: out.bank }, 200);
  });
}
