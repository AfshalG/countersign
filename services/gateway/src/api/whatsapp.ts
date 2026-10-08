import { timingSafeEqual } from 'node:crypto';
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Address } from 'viem';
import { OwnerActionError } from '../owner/send.js';
import { signedByMeta } from '../notify/whatsapp-api.js';
import type { WhatsAppNotifier } from '../notify/whatsapp.js';

/**
 * WhatsApp's routes (Slice 14, D31). No service token: connecting is authorised by an owner's
 * passkey, like the approvals routes, and the webhook by Meta's signature over the body.
 */

export type WhatsAppRouteDeps = {
  notifier: WhatsAppNotifier;
  /** The token Meta echoes when the webhook is set up in the app dashboard. */
  verifyToken: string;
  /** The Meta app's secret, which signs every webhook POST. */
  appSecret: string;
};

const error = z.object({ error: z.string(), message: z.string().optional() });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const issue = createRoute({
  method: 'post',
  path: '/v1/whatsapp/codes',
  tags: ['WhatsApp'],
  summary: 'A code to connect WhatsApp to an account, and the challenge an owner signs for it',
  description:
    'Sign the challenge with an owner’s passkey (POST /v1/whatsapp/codes/{code}), then send "CONNECT <code>" to Countersign’s WhatsApp number. Held payments and proposals for the account then come to that WhatsApp, with a link to decide. The code lasts 15 minutes.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ account: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
        },
      },
    },
  },
  responses: {
    201: json(
      z.object({ code: z.string(), challenge: z.string(), expiresAt: z.string() }),
      'The code, not usable until an owner signs the challenge',
    ),
    404: json(error, 'unknown_account'),
    429: json(error, 'too_many_codes'),
  },
});

const sign = createRoute({
  method: 'post',
  path: '/v1/whatsapp/codes/{code}',
  tags: ['WhatsApp'],
  summary: 'An owner’s passkey makes the code usable; returns the WhatsApp link to send it',
  request: {
    params: z.object({ code: z.string().regex(/^[A-Za-z0-9]{8}$/) }),
    body: { content: { 'application/json': { schema: z.object({ assertion: z.unknown() }) } } },
  },
  responses: {
    200: json(
      z.object({
        account: z.string(),
        number: z.string(),
        text: z.string(),
        link: z
          .string()
          .openapi({ description: 'wa.me link that opens WhatsApp with the message typed' }),
        expiresAt: z.string(),
      }),
      'Send `text` to `number` from WhatsApp (or open `link`) before it expires',
    ),
    400: json(error, 'malformed_assertion'),
    404: json(error, 'unknown_code'),
    409: json(error, 'code_used or code_expired'),
    422: json(error, 'challenge_mismatch or invalid_passkey'),
  },
});

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function registerWhatsAppRoutes(app: OpenAPIHono, deps: WhatsAppRouteDeps): void {
  const { notifier } = deps;

  app.openapi(issue, async (c) => {
    try {
      return c.json(await notifier.issueCode(c.req.valid('json').account as Address), 201);
    } catch (e) {
      if (!(e instanceof OwnerActionError)) throw e;
      return c.json({ error: e.code, message: e.message }, e.status === 429 ? 429 : 404);
    }
  });

  app.openapi(sign, async (c) => {
    try {
      return c.json(
        await notifier.signCode(c.req.valid('param').code, c.req.valid('json').assertion),
        200,
      );
    } catch (e) {
      if (!(e instanceof OwnerActionError)) throw e;
      const status = e.status === 429 ? 409 : e.status;
      return c.json({ error: e.code, message: e.message }, status);
    }
  });

  // Meta's check when the webhook is set up: echo the challenge if the token is ours.
  app.get('/v1/whatsapp/webhook', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token') ?? '';
    const challenge = c.req.query('hub.challenge') ?? '';
    return mode === 'subscribe' && sameText(token, deps.verifyToken)
      ? c.text(challenge, 200)
      : c.text('forbidden', 403);
  });

  // People's messages and delivery statuses. The signature covers the raw body, so it is read as
  // text and checked before anything is parsed. A failure answers 500, and Meta sends it again.
  app.post('/v1/whatsapp/webhook', async (c) => {
    const raw = await c.req.text();
    if (!signedByMeta(raw, c.req.header('x-hub-signature-256'), deps.appSecret))
      return c.json({ error: 'bad_signature' }, 401);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: 'malformed' }, 400);
    }
    await notifier.inbound(payload);
    return c.text('ok', 200);
  });
}
