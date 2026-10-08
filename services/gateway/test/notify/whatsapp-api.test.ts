import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_VERSION,
  signedByMeta,
  WhatsAppApi,
  WhatsAppError,
} from '../../src/notify/whatsapp-api.js';

/** The Cloud API as a fetch function: records each call and answers as Meta does. */
function graph(answer: (body: Record<string, unknown>) => Response) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    return Promise.resolve(answer(body));
  }) as typeof fetch;
  return {
    calls,
    api: new WhatsAppApi({
      phoneNumberId: '106540352242922',
      accessToken: 'EAAJB-token',
      fetch: fetchFn,
    }),
  };
}
const accepted = () =>
  new Response(
    JSON.stringify({
      messaging_product: 'whatsapp',
      contacts: [{ input: '447700900123', wa_id: '447700900123' }],
      messages: [{ id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI4' }],
    }),
    { status: 200 },
  );

describe('the WhatsApp Cloud API client', () => {
  it('sends a link-button message in the shape Meta documents', async () => {
    const { calls, api } = graph(accepted);
    const id = await api.link('447700900123', {
      header: 'Payment held',
      body: 'Countersign held a payment; nothing was paid.',
      button: 'Review and decide on this payment now',
      url: 'https://gateway.test/p/0xabc',
    });
    expect(id).toBe('wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI4');
    expect(calls[0]?.url).toBe(
      `https://graph.facebook.com/${GRAPH_VERSION}/106540352242922/messages`,
    );
    expect(calls[0]?.auth).toBe('Bearer EAAJB-token');
    expect(calls[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '447700900123',
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        header: { type: 'text', text: 'Payment held' },
        body: { text: 'Countersign held a payment; nothing was paid.' },
        action: {
          name: 'cta_url',
          // WhatsApp allows 20 characters on the button.
          parameters: { display_text: 'Review and decide o…', url: 'https://gateway.test/p/0xabc' },
        },
      },
    });
  });

  it('sends a template with its body parameter on one line and the URL button’s suffix', async () => {
    const { calls, api } = graph(accepted);
    await api.template('447700900123', {
      name: 'countersign_decision',
      language: 'en',
      text: 'a payment was held:\n  the address   changed',
      urlSuffix: '0xabc',
    });
    expect(calls[0]?.body.template).toEqual({
      name: 'countersign_decision',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: 'a payment was held: the address changed' }],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: '0xabc' }],
        },
      ],
    });
  });

  it('says what Meta refused, and when it could not be reached', async () => {
    const { api } = graph(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: '(#131030) Recipient phone number not in allowed list',
              code: 131030,
            },
          }),
          { status: 400 },
        ),
    );
    const refused = await api.text('447700900123', 'hi').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WhatsAppError);
    expect(refused).toMatchObject({
      message: '(#131030) Recipient phone number not in allowed list',
      status: 400,
      code: 131030,
    });
    const down = new WhatsAppApi({
      phoneNumberId: '1',
      accessToken: 'EAAJB-token',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(down.text('447700900123', 'hi')).rejects.toMatchObject({
      message: 'WhatsApp unreachable: fetch failed',
      status: 0,
    });
  });
});

describe('the webhook signature', () => {
  const secret = 'meta-app-secret-0123456789';
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  const header = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts Meta’s HMAC of the raw body and nothing else', () => {
    expect(signedByMeta(body, header, secret)).toBe(true);
    expect(signedByMeta(`${body} `, header, secret)).toBe(false);
    expect(signedByMeta(body, header, 'another-secret-0123456789')).toBe(false);
    expect(signedByMeta(body, undefined, secret)).toBe(false);
    expect(signedByMeta(body, header.replace('sha256=', 'sha1='), secret)).toBe(false);
    expect(signedByMeta(body, 'sha256=zz', secret)).toBe(false);
  });
});
