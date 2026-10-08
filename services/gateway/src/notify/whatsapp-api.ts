import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The WhatsApp Business Cloud API, the three messages Countersign sends (Slice 14, D31; checked
 * against Meta's docs 8 Oct 2026, Graph API v25.0):
 * - a link-button message (`interactive`, `cta_url`), allowed within 24 hours of the person's
 *   last message to the number;
 * - an approved template with a URL button, outside that window (the button's URL is fixed in the
 *   template up to `{{1}}`, which is the payment's or proposal's id);
 * - plain text, for replies to the person's own messages.
 */

export const GRAPH_VERSION = 'v25.0';

export type WhatsAppConfig = {
  phoneNumberId: string;
  accessToken: string;
  /** For tests. */
  fetch?: typeof fetch;
  graphUrl?: string;
};

/** Meta refused or could not be reached; `code` is Meta's error code when it gave one. */
export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

/** WhatsApp's limits: button label 20 characters, body 1024, template parameters single-line. */
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export class WhatsAppApi {
  private readonly fetch: typeof fetch;
  private readonly base: string;

  constructor(private readonly config: WhatsAppConfig) {
    this.fetch = config.fetch ?? fetch;
    this.base = `${config.graphUrl ?? 'https://graph.facebook.com'}/${GRAPH_VERSION}/${config.phoneNumberId}/messages`;
  }

  /** A message with one button that opens `url`. Returns WhatsApp's message id. */
  link(to: string, m: { header: string; body: string; button: string; url: string }) {
    return this.send({
      to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        header: { type: 'text', text: clip(m.header, 60) },
        body: { text: clip(m.body, 1024) },
        action: {
          name: 'cta_url',
          parameters: { display_text: clip(m.button, 20), url: m.url },
        },
      },
    });
  }

  /** An approved template: one body parameter and the URL button's suffix. */
  template(to: string, t: { name: string; language: string; text: string; urlSuffix: string }) {
    return this.send({
      to,
      type: 'template',
      template: {
        name: t.name,
        language: { code: t.language },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: clip(oneLine(t.text), 900) }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: t.urlSuffix }],
          },
        ],
      },
    });
  }

  text(to: string, body: string) {
    return this.send({ to, type: 'text', text: { body: clip(body, 4096), preview_url: false } });
  }

  private async send(message: Record<string, unknown>): Promise<string> {
    let res: Response;
    try {
      res = await this.fetch(this.base, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          ...message,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new WhatsAppError(
        `WhatsApp unreachable: ${e instanceof Error ? e.message : String(e)}`,
        0,
        null,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string; code?: number };
    };
    const id = body.messages?.[0]?.id;
    if (!res.ok || id === undefined)
      throw new WhatsAppError(
        body.error?.message ?? `WhatsApp answered ${String(res.status)}`,
        res.status,
        body.error?.code ?? null,
      );
    return id;
  }
}

/**
 * Whether a webhook POST came from Meta: `X-Hub-Signature-256` is `sha256=` and the HMAC-SHA256 of
 * the raw body with the app secret. Compared in constant time; anything malformed is false.
 */
export function signedByMeta(rawBody: string, header: string | undefined, appSecret: string) {
  if (header === undefined || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
