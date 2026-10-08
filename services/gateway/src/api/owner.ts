import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Address } from 'viem';
import { ownerView, setPaused, type PauseDeps } from '../owner/pause.js';
import { changeOwners, previewOwners } from '../owner/owners.js';
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
const signatures = z
  .object({ need: z.number().int(), signed: z.array(z.number().int()) })
  .openapi('OwnerSignatures', {
    description: 'D36: owners this action needs, and which (by index) have signed it',
  });
const ownerKey = z.object({ qx: z.string(), qy: z.string() });
const ownerChange = z
  .object({
    challenge: z.string().openapi({ description: 'What each owner’s passkey signs' }),
    deadline: z.number().int().openapi({ description: 'Send it back with the assertion' }),
    owners: z.array(ownerKey),
    manage: z.number().int(),
    release: z.number().int(),
    summary: z.string(),
    typedData: z.unknown(),
    signatures,
  })
  .openapi('OwnerChange');
const publicKey = z
  .object({ x: z.string().optional(), y: z.string().optional(), spki: z.string().optional() })
  .openapi('PasskeyPublicKey', {
    description:
      '`{ x, y }` as hex, or `{ spki }` (base64url, as response.getPublicKey() returns it)',
  });
const change = z.object({
  owners: z.array(publicKey).min(1).max(5).openapi({
    description: 'Every owner after the change, the current ones included, in order',
  }),
  manage: z.number().int(),
  release: z.number().int(),
});
const ownerState = z
  .object({
    account: z.string(),
    paused: z.boolean(),
    owners: z
      .array(z.object({ owner: z.number().int(), qx: z.string(), qy: z.string() }))
      .openapi({ description: 'The owners’ passkey public keys; signatures name them by index' }),
    manage: z.number().int().openapi({
      description: 'Owners needed to manage: suppliers, orders, policy, owners, unpause',
    }),
    release: z.number().int().openapi({ description: 'Owners needed to pay a held payment once' }),
    actions: z
      .record(
        z.string(),
        z.object({
          challenge: z.string().openapi({ description: 'What the passkey signs' }),
          deadline: z.number().int().openapi({ description: 'Send it back with the assertion' }),
          summary: z.string(),
          typedData: z.unknown(),
          signatures,
        }),
      )
      .openapi({ description: '`pause` when running, `unpause` when paused' }),
    ownerChanges: z.array(ownerChange).openapi({
      description: 'D36: owner changes some owners have signed, waiting for the others',
    }),
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
  summary: 'Pause or unpause with an owner’s passkey (the stop button)',
  description:
    'While paused, every vault refuses to pay; a payment meanwhile is held with reason `paused`. Any one owner can pause; unpausing needs the account’s manage threshold, so with several owners it answers 202 until enough have signed the same challenge (D36).',
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
    202: json(ownerState, 'Unpause counted: it waits for more owners’ passkeys (D36)'),
    400: json(ownerError, 'bad_deadline or malformed_assertion'),
    409: json(ownerError, 'already_paused, not_paused, stale or contract_refuses'),
    422: json(ownerError, 'challenge_mismatch or invalid_passkey'),
  },
});

const preview = createRoute({
  method: 'post',
  path: '/v1/owner/{account}/owners/preview',
  tags: ['Owner'],
  summary: 'Preview a change of owners and thresholds: the challenge each owner signs (D36)',
  description:
    'Nothing is stored. Add an owner by listing the current owners and the new passkey’s public key; remove one by leaving it out.',
  request: {
    params: accountParam,
    body: { content: { 'application/json': { schema: change } } },
  },
  responses: {
    200: json(ownerChange, 'The change, ready to sign'),
    400: json(ownerError, 'bad_owners or invalid_public_key'),
    503: json(ownerError, 'chain_unavailable'),
  },
});

const setOwners = createRoute({
  method: 'post',
  path: '/v1/owner/{account}/owners',
  tags: ['Owner'],
  summary: 'Sign a change of owners with one owner’s passkey (D36)',
  description:
    'Sent once the account’s manage threshold of current owners has signed the same challenge; until then it answers 202 and the change is listed with the account for the others.',
  request: {
    params: accountParam,
    body: {
      content: {
        'application/json': {
          schema: change.extend({ deadline: z.number().int(), assertion: z.unknown() }),
        },
      },
    },
  },
  responses: {
    200: json(ownerState, 'Done: final on Monad'),
    202: json(ownerState, 'Counted: waiting for more owners'),
    400: json(ownerError, 'bad_owners, invalid_public_key, bad_deadline or malformed_assertion'),
    409: json(ownerError, 'stale or contract_refuses'),
    422: json(ownerError, 'challenge_mismatch or invalid_passkey'),
  },
});

export function registerOwnerRoutes(app: OpenAPIHono, deps: PauseDeps): void {
  app.openapi(preview, async (c) => {
    try {
      return c.json(
        await previewOwners(deps, c.req.valid('param').account as Address, c.req.valid('json')),
        200,
      );
    } catch (e) {
      if (e instanceof OwnerActionError && e.status === 400)
        return c.json({ error: e.code, message: e.message }, 400);
      console.error(`owners preview: ${e instanceof Error ? e.message : String(e)}`);
      return c.json({ error: 'chain_unavailable' }, 503);
    }
  });

  app.openapi(setOwners, async (c) => {
    const account = c.req.valid('param').account as Address;
    const { assertion, ...body } = c.req.valid('json');
    try {
      const { waiting } = await changeOwners(deps, account, body, assertion);
      return c.json(await ownerView(deps, account), waiting ? 202 : 200);
    } catch (e) {
      if (!(e instanceof OwnerActionError)) throw e;
      const status = e.status === 404 || e.status === 429 ? 409 : e.status;
      return c.json({ error: e.code, message: e.message }, status);
    }
  });

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
      // Still paused after an unpause: counted, waiting for the manage threshold (D36).
      return c.json(view, body.action === 'unpause' && view.paused ? 202 : 200);
    } catch (e) {
      if (!(e instanceof OwnerActionError)) throw e;
      const status = e.status === 404 || e.status === 429 ? 409 : e.status;
      return c.json({ error: e.code, message: e.message }, status);
    }
  });
}
