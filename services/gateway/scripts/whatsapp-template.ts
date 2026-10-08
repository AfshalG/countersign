/**
 * Creates Countersign's WhatsApp template (Slice 14, D31) in the WhatsApp Business account: the
 * message sent outside WhatsApp's 24-hour window, when a payment is held or a supplier proposed.
 * A utility template; Meta reviews it (usually minutes, up to 24 hours). Run once, then set
 * WHATSAPP_TEMPLATE=countersign_decision on the gateway.
 *
 *   pnpm --filter @countersign/gateway whatsapp-template
 */
import { z } from 'zod';
import { loadEnv } from '@countersign/shared';
import { GRAPH_VERSION } from '../src/notify/whatsapp-api.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^\d{5,20}$/),
    WHATSAPP_ACCESS_TOKEN: z.string().min(20),
  }),
);
const gateway = 'https://gateway-production-e17a.up.railway.app';

const res = await fetch(
  `https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'countersign_decision',
      language: 'en',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          // The notifier's summary goes in {{1}}; a variable may not start or end the body.
          text: 'Countersign needs your decision: {{1}}. Open it to decide with your passkey.',
          example: {
            body_text: [
              [
                "a payment of 0.001 USDC to Kalibre Studio was held: The invoice's payment address is not the supplier's address on file",
              ],
            ],
          },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'Review and decide',
              url: `${gateway}/p/{{1}}`,
              example: ['0x3d54398e28462385957996f25cad41225373300c78d56b6e4a62943359c75a40'],
            },
          ],
        },
      ],
    }),
  },
);
const body = (await res.json()) as {
  id?: string;
  status?: string;
  error?: { message?: string };
};
if (!res.ok)
  throw new Error(`Meta refused the template: ${body.error?.message ?? String(res.status)}`);
console.log(`template countersign_decision: ${body.status ?? 'unknown'} (id ${body.id ?? '?'})`);
