import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Address } from 'viem';
import { ownerView, setPaused, type PauseDeps } from '../owner/pause.js';
import { OwnerActionError } from '../owner/send.js';

/**
 * The stop button's routes (Slice 9 part 3). No service token and any origin, like the approvals
 * routes: the phone calls them, and the owner's passkey is the authorisation, checked by the
 * account itself.
 */

const accountParam = z.object({
  account: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .openapi({
      param: { name: 'account', in: 'path' },
      example: '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603',
    }),
});
const ownerState = z
  .object({
    account: z.string(),
    paused: z.boolean(),
    actions: z
      .record(
        z.string(),
        z.object({
          challenge: z.string().openapi({ description: 'What the passkey signs' }),
          deadline: z.number().int().openapi({ description: 'Send it back with the assertion' }),
          summary: z.string(),
          typedData: z.unknown(),
        }),
      )
      .openapi({ description: '`pause` when running, `unpause` when paused' }),
  })
  .openapi('OwnerState');
const ownerError = z.object({ error: z.string(), message: z.string().optional() });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const getOwner = createRoute({
  method: 'get',
  path: '/v1/owner/{account}',
  tags: ['Owner'],
  summary: 'Whether the account is paused, and the action that changes it, ready to sign',
  request: { params: accountParam },
  responses: {
    200: json(ownerState, 'The account’s state'),
    503: json(ownerError, 'chain_unavailable'),
  },
});

const setOwner = createRoute({
  method: 'post',
  path: '/v1/owner/{account}',
  tags: ['Owner'],
  summary: 'Pause or unpause with the owner’s passkey (the stop button)',
  description:
    'While paused, every vault refuses to pay; a payment meanwhile is held with reason `paused`.',
  request: {
    params: accountParam,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            action: z.enum(['pause', 'unpause']),
            deadline: z.number().int(),
            assertion: z.unknown(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(ownerState, 'Done: final on Monad'),
    400: json(ownerError, 'bad_deadline or malformed_assertion'),
    409: json(ownerError, 'already_paused, not_paused, stale or contract_refuses'),
    422: json(ownerError, 'challenge_mismatch or invalid_passkey'),
  },
});

export function registerOwnerRoutes(app: OpenAPIHono, deps: PauseDeps): void {
  app.openapi(getOwner, async (c) => {
    try {
      return c.json(await ownerView(deps, c.req.valid('param').account as Address), 200);
    } catch (e) {
      console.error(`owner view: ${e instanceof Error ? e.message : String(e)}`);
      return c.json({ error: 'chain_unavailable' }, 503);
    }
  });

  app.openapi(setOwner, async (c) => {
    const body = c.req.valid('json');
    try {
      const view = await setPaused(
        deps,
        c.req.valid('param').account as Address,
        body.action,
        body.deadline,
        body.assertion,
      );
      return c.json(view, 200);
    } catch (e) {
      if (!(e instanceof OwnerActionError)) throw e;
      const status = e.status === 404 || e.status === 429 ? 409 : e.status;
      return c.json({ error: e.code, message: e.message }, status);
    }
  });
}
