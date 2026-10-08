/**
 * Connects a phone's WhatsApp to the hosted demo account (Slice 14, D31), as the approval page
 * will: asks the gateway for a code, signs its challenge with the account's passkey (Slice 5's
 * software key; on a phone, the real passkey), and prints the message to send from WhatsApp.
 *
 *   pnpm --filter @countersign/gateway whatsapp-connect [gateway URL]
 */
import { z } from 'zod';
import type { Hex } from 'viem';
import { loadEnv } from '@countersign/shared';
import { SoftPasskey } from './passkey.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(z.object({ SLICE5_OWNER_P256_KEY: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }));
const gateway = (process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app').replace(
  /\/$/,
  '',
);
const ACCOUNT = '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9';
const owner = SoftPasskey.fromScalar(env.SLICE5_OWNER_P256_KEY);

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${gateway}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok)
    throw new Error(`${path}: ${String(res.status)} ${json.error ?? ''} ${json.message ?? ''}`);
  return json;
}

const issued = await post<{ code: string; challenge: Hex }>('/v1/whatsapp/codes', {
  account: ACCOUNT,
});
const a = owner.sign(issued.challenge);
const signed = await post<{ text: string; number: string; link: string; expiresAt: string }>(
  `/v1/whatsapp/codes/${issued.code}`,
  {
    assertion: {
      authenticatorData: a.authenticatorData,
      clientDataJSON: a.clientDataJSON,
      signature: { r: a.r, s: a.s },
    },
  },
);
console.log(
  `From WhatsApp, before ${signed.expiresAt}, send:\n\n  ${signed.text}\n\nto +${signed.number}, or open on the phone:\n\n  ${signed.link}\n`,
);
