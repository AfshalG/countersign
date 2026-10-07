import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Address } from 'viem';
import {
  createDemoAccount,
  DemoError,
  demoView,
  publicKeyOf,
  setUpDemoAccount,
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
  .openapi({ example: '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603' });

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
    'Give the public key from navigator.credentials.create: `{ x, y }` as hex, or `{ spki }` (base64url, as response.getPublicKey() returns it). The same passkey always gets the same account. The answer lists the three setup actions to sign with that passkey.',
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

const refusal = (e: DemoError) => ({
  error: e.code,
  message: e.message,
  ...(e.detail === undefined ? {} : { detail: e.detail }),
});

export function registerDemoRoutes(app: OpenAPIHono, deps: DemoDeps): void {
  app.openapi(createAccountRoute, async (c) => {
    try {
      const view = await createDemoAccount(deps, publicKeyOf(c.req.valid('json').publicKey));
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
}
