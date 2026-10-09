import type { Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { z } from 'zod';
import { loadEnv, monadChainId } from '@countersign/shared';

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((k) => k as Hex);

/** The gateway's settings, checked at start: a missing or bad one stops it before it touches a payment. */
export function loadSettings(source?: Record<string, string | undefined>) {
  return loadEnv(
    z.object({
      DATABASE_URL: z.url(),
      MONAD_CHAIN_ID: monadChainId,
      MONAD_WS_URL: z.url(),
      RELAYER_PRIVATE_KEYS: z
        .string()
        .transform((v) => v.split(',').map((k) => k.trim()))
        .pipe(z.array(privateKey).min(1)),
      // Sent by the MCP server and the apps; developers' accounts use account tokens instead.
      GATEWAY_SERVICE_TOKEN: z
        .string()
        .min(24)
        .regex(/^[A-Za-z0-9._~+/-]+=*$/),
      // The checker service (Slice 10), all three or none: where it is, the token the gateway
      // sends it, and the address it signs with (named in judge accounts' policies). The gateway
      // then holds no checker key.
      CHECKER_URL: z.url().optional(),
      CHECKER_TOKEN: z.string().min(24).optional(),
      CHECKER_ADDRESS: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .transform((a) => a as `0x${string}`)
        .optional(),
      // The stand-in checker's key, without the service (tests, local runs). Testnet only.
      TEST_CHECKER_PRIVATE_KEY: privateKey.optional(),
      // Where people open status pages (the links in agents' messages). On Railway:
      // https://${{RAILWAY_PUBLIC_DOMAIN}}.
      PUBLIC_URL: z.url(),
      PORT: z
        .string()
        .regex(/^\d{2,5}$/)
        .transform(Number),
      // Judge mode (Slice 9 part 4), testnet only, both or neither: the wallet that funds demo
      // accounts with test USDC (it holds only that and a little MON), and the hosted demo agent
      // named in their policies.
      DEMO_FUNDER_PRIVATE_KEY: privateKey.optional(),
      DEMO_AGENT_PRIVATE_KEY: privateKey.optional(),
      // WhatsApp (Slice 14, D31), the first five together or none: the Cloud API phone number's id
      // and its access token, the Meta app's secret (signs webhooks), the webhook's verify token,
      // and the number people message, digits with the country code. The template is for
      // messages outside WhatsApp's 24-hour window; without it those are skipped.
      WHATSAPP_PHONE_NUMBER_ID: z
        .string()
        .regex(/^\d{5,20}$/)
        .optional(),
      WHATSAPP_ACCESS_TOKEN: z.string().min(20).optional(),
      WHATSAPP_APP_SECRET: z.string().min(16).optional(),
      WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
      WHATSAPP_NUMBER: z
        .string()
        .regex(/^\d{7,15}$/)
        .optional(),
      WHATSAPP_TEMPLATE: z
        .string()
        .regex(/^[a-z0-9_]{1,512}$/)
        .optional(),
      WHATSAPP_TEMPLATE_LANGUAGE: z
        .string()
        .regex(/^[a-z]{2}(_[A-Z]{2})?$/)
        .optional(),
      // Primus's Core SDK keys (Slice 15), both or none: suppliers' websites are proven with them.
      PRIMUS_APP_ID: z.string().min(1).optional(),
      PRIMUS_APP_SECRET: z.string().min(1).optional(),
      // Slice 18 (S18-4): write checker holds and owner refusals on Monad (each costs testnet MON).
      // On unless set to "false"; off, decisions are kept and sent once it is on again.
      RECORD_DECISIONS: z.enum(['true', 'false']).optional(),
      // How many payments are checked at once (D16): sized from a measured burst (Slice 16).
      CHECK_CONCURRENCY: z
        .string()
        .regex(/^\d{1,3}$/)
        .transform(Number)
        .pipe(z.number().int().min(1).max(64))
        .optional(),
      // New demo accounts per UTC day; each costs about 0.09 MON to set up.
      DEMO_ACCOUNTS_PER_DAY: z
        .string()
        .regex(/^\d{1,4}$/)
        .transform(Number)
        .optional(),
    }),
    source,
  );
}

/** Judge mode's settings when it is on; a half-configured judge mode is a mistake, not an off switch. */
export function judgeMode(settings: ReturnType<typeof loadSettings>) {
  const { DEMO_FUNDER_PRIVATE_KEY: funderKey, DEMO_AGENT_PRIVATE_KEY: agentKey } = settings;
  if (funderKey === undefined && agentKey === undefined) return undefined;
  if (funderKey === undefined || agentKey === undefined)
    throw new Error('Set both DEMO_FUNDER_PRIVATE_KEY and DEMO_AGENT_PRIVATE_KEY, or neither');
  return {
    funderKey,
    agentKey,
    agent: privateKeyToAddress(agentKey),
    perDay: settings.DEMO_ACCOUNTS_PER_DAY ?? 20,
  };
}

/**
 * Which checker the gateway asks: the checker service when it is configured (Slice 10), else the
 * stand-in with its key. A half-configured checker is a mistake, not a fallback.
 */
export function checkerMode(settings: ReturnType<typeof loadSettings>) {
  const { CHECKER_URL: url, CHECKER_TOKEN: token, CHECKER_ADDRESS: address } = settings;
  const set = [url, token, address].filter((v) => v !== undefined).length;
  if (set > 0 && (url === undefined || token === undefined || address === undefined))
    throw new Error('Set CHECKER_URL, CHECKER_TOKEN and CHECKER_ADDRESS together, or none');
  if (url !== undefined && token !== undefined && address !== undefined)
    return { kind: 'remote' as const, url: url.replace(/\/$/, ''), token, address };
  const key = settings.TEST_CHECKER_PRIVATE_KEY;
  if (key === undefined)
    throw new Error(
      'No checker: set the checker service (CHECKER_URL, …) or TEST_CHECKER_PRIVATE_KEY',
    );
  return { kind: 'stand-in' as const, key, address: privateKeyToAddress(key) };
}

/** WhatsApp's settings when it is on (Slice 14); a half-configured WhatsApp is a mistake. */
export function whatsappMode(settings: ReturnType<typeof loadSettings>) {
  const required = {
    phoneNumberId: settings.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: settings.WHATSAPP_ACCESS_TOKEN,
    appSecret: settings.WHATSAPP_APP_SECRET,
    verifyToken: settings.WHATSAPP_VERIFY_TOKEN,
    number: settings.WHATSAPP_NUMBER,
  };
  const set = Object.values(required).filter((v) => v !== undefined).length;
  if (set === 0) return undefined;
  const { phoneNumberId, accessToken, appSecret, verifyToken, number } = required;
  if (
    phoneNumberId === undefined ||
    accessToken === undefined ||
    appSecret === undefined ||
    verifyToken === undefined ||
    number === undefined
  )
    throw new Error(
      'Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN and WHATSAPP_NUMBER together, or none',
    );
  return {
    phoneNumberId,
    accessToken,
    appSecret,
    verifyToken,
    number,
    ...(settings.WHATSAPP_TEMPLATE === undefined
      ? {}
      : {
          template: {
            name: settings.WHATSAPP_TEMPLATE,
            language: settings.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en',
          },
        }),
  };
}

/** Primus's keys when website proofs are on (Slice 15); without them every check is unproven. */
export function primusKeys(settings: ReturnType<typeof loadSettings>) {
  const { PRIMUS_APP_ID: appId, PRIMUS_APP_SECRET: appSecret } = settings;
  if (appId === undefined && appSecret === undefined) return undefined;
  if (appId === undefined || appSecret === undefined)
    throw new Error('Set PRIMUS_APP_ID and PRIMUS_APP_SECRET together, or none');
  return { appId, appSecret };
}
