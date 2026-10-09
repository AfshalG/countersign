import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Address } from 'viem';
import { demoPlan } from '../demo/plan.js';
import { DEMO_INVOICE_KINDS, demoInvoice, sdkAgent } from '../demo/invoices.js';
import {
  createDemoAccount,
  DemoError,
  demoView,
  issueAccountToken,
  publicKeyOf,
  setUpDemoAccount,
  tokenAsk,
  type DemoDeps,
} from '../demo/accounts.js';

/**
 * Judge mode's routes (Slice 9 part 4, D35). Like the approvals routes they take no service
 * token and allow any origin: the approver app calls them from a phone's browser, and the
 * passkey is the authorisation. Creating an account spends MON, so a daily limit applies.
 */

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .openapi({ example: '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9' });

const setupActionView = z.object({
  action: z.enum(['setPolicy', 'setSupplier', 'approveOrder']),
  nonce: z.number().int(),
  summary: z.string().openapi({ description: 'What this signature does, in plain words' }),
  challenge: z.string().openapi({
    description: 'The EIP-712 digest the passkey signs as its WebAuthn challenge',
  }),
  typedData: z.unknown().openapi({ description: 'The typed data behind the challenge' }),
});

export const demoAccountView = z
  .object({
    account: address,
    status: z.enum(['creating', 'awaiting_passkey', 'setting_up', 'ready']),
    agent: z.object({ address, hosted: z.boolean() }).openapi({
      description:
        'The agent key the policy names: the hosted demo agent, or the developer’s own (`hosted: false`), which pays the account’s invoices itself',
    }),
    waitingPeriodSeconds: z.number().int().openapi({
      description: 'Demo accounts have none, so a judge can pay at once (real accounts: 48 hours)',
    }),
    fundedUsdc: z.string(),
    signBy: z.string().openapi({ description: 'The three signatures are valid until then' }),
    actions: z.array(setupActionView).openapi({
      description:
        'Sign each challenge with the passkey, in order; empty once the account is ready',
    }),
    order: z
      .object({
        orderId: z.string(),
        supplier: z.string(),
        payTo: address,
        amountUsdc: z.string(),
      })
      .nullable(),
  })
  .openapi('DemoAccount');

const demoError = z
  .object({
    error: z.string(),
    message: z.string(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('DemoError');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const createAccountRoute = createRoute({
  method: 'post',
  path: '/v1/demo/accounts',
  tags: ['Judge mode'],
  summary: 'Create a testnet account for a new passkey, funded with 0.01 USDC',
  description:
    'Give the public key from navigator.credentials.create: `{ x, y }` as hex, or `{ spki }` (base64url, as response.getPublicKey() returns it). The same passkey always gets the same account. The answer lists the three setup actions to sign with that passkey. A developer adds `agent`, their own agent key’s address: the policy then names it, and it is a separate account for that passkey and agent (a test account; then get a token with POST …/token).',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            publicKey: z.object({
              x: z.string().optional(),
              y: z.string().optional(),
              spki: z.string().optional(),
            }),
            agent: address.optional().openapi({
              description: 'Your own agent key’s address (a developer’s test account)',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: json(demoAccountView, 'The account and what its passkey signs next'),
    400: json(demoError, 'invalid_public_key'),
    409: json(demoError, 'contract_refuses or reverted'),
    429: json(demoError, 'demo_limit: today’s demo accounts are used up'),
  },
});

const accountParam = z.object({
  account: address.openapi({ param: { name: 'account', in: 'path' } }),
});

const getAccountRoute = createRoute({
  method: 'get',
  path: '/v1/demo/accounts/{account}',
  tags: ['Judge mode'],
  summary: 'A demo account: its status, the actions left to sign, or its order once ready',
  request: { params: accountParam },
  responses: {
    200: json(demoAccountView, 'The demo account'),
    404: json(demoError, 'unknown_account'),
  },
});

const setupRoute = createRoute({
  method: 'post',
  path: '/v1/demo/accounts/{account}/setup',
  tags: ['Judge mode'],
  summary: 'Set the account up with its passkey: the policy, the supplier, then the order',
  description:
    'Three assertions, in the order of `actions`, each as the browser or `ox` gives it. Each is checked against its own challenge before anything reaches the chain.',
  request: {
    params: accountParam,
    body: {
      content: {
        'application/json': {
          schema: z.object({ assertions: z.array(z.unknown()).length(3) }),
        },
      },
    },
  },
  responses: {
    200: json(demoAccountView, 'Ready: the order is open'),
    400: json(demoError, 'malformed_assertion'),
    404: json(demoError, 'unknown_account'),
    409: json(demoError, 'not_created, contract_refuses or reverted'),
    422: json(demoError, 'challenge_mismatch or invalid_passkey'),
  },
});

const invoiceRoute = createRoute({
  method: 'post',
  path: '/v1/demo/accounts/{account}/invoices',
  tags: ['Judge mode'],
  summary: 'Have the demo agent pay a Kalibre Studio invoice into this account',
  description:
    '`clean` pays the address on file and settles. `changed_address` uses a look-alike address (same first six and last four characters): the contract refuses it, so it is held and can only be refused. `amount_mismatch` is held by the stand-in checker until the real checker (Slice 10) reads invoices: pay it once or refuse it with the account’s passkey. Each is 0.001 USDC, from the account’s 0.005 order.',
  request: {
    params: accountParam,
    body: {
      content: { 'application/json': { schema: z.object({ kind: z.enum(DEMO_INVOICE_KINDS) }) } },
    },
  },
  responses: {
    200: json(
      z
        .object({
          kind: z.enum(DEMO_INVOICE_KINDS),
          requestId: z.string(),
          status: z.string(),
          reason: z.string().nullable(),
          reasonText: z.string().nullable(),
          txHash: z.string().nullable(),
          approvalUrl: z.string().nullable().openapi({
            description: 'When held: what the phone shows and signs (GET), and where it posts',
          }),
          statusUrl: z.string(),
        })
        .openapi('DemoInvoice'),
      'Paid, or held for the owner',
    ),
    404: json(demoError, 'unknown_account'),
    409: json(
      demoError,
      'not_ready (set the account up first), not_hosted (the account names your own agent: it pays), order_not_indexed (just set up: try again in a few seconds) or order_used_up',
    ),
  },
});

const tokenAskRoute = createRoute({
  method: 'get',
  path: '/v1/demo/accounts/{account}/token',
  tags: ['Judge mode'],
  summary: 'What an owner’s passkey signs to get an API token for this account',
  request: { params: accountParam },
  responses: {
    200: json(
      z
        .object({
          account: address,
          generation: z.number().int(),
          challenge: z.string().openapi({ description: 'Sign it as the WebAuthn challenge' }),
          summary: z.string(),
        })
        .openapi('TokenChallenge'),
      'The challenge for the next token',
    ),
    404: json(demoError, 'unknown_account'),
  },
});

const tokenRoute = createRoute({
  method: 'post',
  path: '/v1/demo/accounts/{account}/token',
  tags: ['Judge mode'],
  summary: 'Get an API token that reaches only this account',
  description:
    'One owner’s passkey signs the challenge from GET. The token is shown once and stored only as a hash; it can call this account’s payments, checks, runs, orders, proposals and feed, and nothing else. A new token revokes the previous one.',
  request: {
    params: accountParam,
    body: { content: { 'application/json': { schema: z.object({ assertion: z.unknown() }) } } },
  },
  responses: {
    200: json(
      z
        .object({
          account: address,
          token: z.string().openapi({ example: 'cs_…' }),
          generation: z.number().int(),
          note: z.string(),
        })
        .openapi('AccountToken'),
      'The token, shown once',
    ),
    400: json(demoError, 'malformed_assertion'),
    404: json(demoError, 'unknown_account'),
    409: json(demoError, 'not_created or token_used'),
    422: json(demoError, 'challenge_mismatch or invalid_passkey'),
  },
});

const refusal = (e: DemoError) => ({
  error: e.code,
  message: e.message,
  ...(e.detail === undefined ? {} : { detail: e.detail }),
});

export function registerDemoRoutes(
  app: OpenAPIHono,
  deps: DemoDeps,
  options: { token: string; publicUrl: string },
): void {
  const agent =
    deps.agent ??
    (deps.agentPrivateKey === undefined
      ? undefined
      : sdkAgent({
          request: (url, init) => app.request(url, init),
          token: options.token,
          agentKey: deps.agentPrivateKey,
          chainId: deps.chainId,
        }));

  app.openapi(createAccountRoute, async (c) => {
    try {
      const body = c.req.valid('json');
      const view = await createDemoAccount(
        deps,
        publicKeyOf(body.publicKey),
        body.agent as Address | undefined,
      );
      return c.json(view, 200);
    } catch (e) {
      if (!(e instanceof DemoError)) throw e;
      if (e.status === 400 || e.status === 409 || e.status === 429)
        return c.json(refusal(e), e.status);
      throw e;
    }
  });

  app.openapi(getAccountRoute, async (c) => {
    const row = await deps.store.getDemoAccount(c.req.valid('param').account as Address);
    if (!row)
      return c.json({ error: 'unknown_account', message: 'no demo account at this address' }, 404);
    return c.json(demoView(row, deps.chainId), 200);
  });

  app.openapi(invoiceRoute, async (c) => {
    const account = c.req.valid('param').account as Address;
    const row = await deps.store.getDemoAccount(account);
    if (!row)
      return c.json({ error: 'unknown_account', message: 'no demo account at this address' }, 404);
    if (row.status !== 'ready' || agent === undefined)
      return c.json(
        { error: 'not_ready', message: 'set the account up with its passkey first' },
        409,
      );
    const kind = c.req.valid('json').kind;
    const plan = demoPlan.fromJson(row.plan as Parameters<typeof demoPlan.fromJson>[0]);
    if (plan.ownAgent)
      return c.json(
        {
          error: 'not_hosted',
          message:
            'this account names your own agent: pay the supplier site’s invoices with it (the demo agent’s key is not on the policy)',
        },
        409,
      );
    const paid = await agent.pay(
      account,
      demoInvoice(kind, plan.supplier.payTo),
      plan.order.orderId,
    );
    if (paid === 'not_indexed')
      return c.json(
        {
          error: 'order_not_indexed',
          message:
            'the demo order is still being indexed (it follows finalized blocks); try again in a few seconds',
        },
        409,
      );
    if (paid === 'no_open_order')
      return c.json(
        { error: 'order_used_up', message: 'this account’s demo order has nothing left to pay' },
        409,
      );
    return c.json(
      {
        kind,
        requestId: paid.id,
        status: paid.status,
        reason: paid.reason,
        reasonText: paid.reasonText,
        txHash: paid.txHash,
        approvalUrl: paid.status === 'held' ? `${options.publicUrl}/v1/approvals/${paid.id}` : null,
        statusUrl: `${options.publicUrl}/p/${paid.id}`,
      },
      200,
    );
  });

  app.openapi(setupRoute, async (c) => {
    try {
      const view = await setUpDemoAccount(
        deps,
        c.req.valid('param').account as Address,
        c.req.valid('json').assertions,
      );
      return c.json(view, 200);
    } catch (e) {
      if (!(e instanceof DemoError)) throw e;
      if (e.status === 429) throw e;
      return c.json(refusal(e), e.status);
    }
  });

  app.openapi(tokenAskRoute, async (c) => {
    try {
      return c.json(await tokenAsk(deps, c.req.valid('param').account as Address), 200);
    } catch (e) {
      if (e instanceof DemoError && e.status === 404) return c.json(refusal(e), 404);
      throw e;
    }
  });

  app.openapi(tokenRoute, async (c) => {
    try {
      const issued = await issueAccountToken(
        deps,
        c.req.valid('param').account as Address,
        c.req.valid('json').assertion,
      );
      return c.json(issued, 200);
    } catch (e) {
      if (!(e instanceof DemoError)) throw e;
      if (e.status === 400 || e.status === 404 || e.status === 409 || e.status === 422)
        return c.json(refusal(e), e.status);
      throw e;
    }
  });
}
