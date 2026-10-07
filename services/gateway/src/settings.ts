import type { Hex } from 'viem';
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
      // Sent by the MCP server and the apps; per-account sign-in replaces it in Slice 13.
      GATEWAY_SERVICE_TOKEN: z
        .string()
        .min(24)
        .regex(/^[A-Za-z0-9._~+/-]+=*$/),
      // The stand-in checker's key until the checker service exists (Slice 10). Testnet only.
      TEST_CHECKER_PRIVATE_KEY: privateKey,
      PORT: z
        .string()
        .regex(/^\d{2,5}$/)
        .transform(Number),
    }),
    source,
  );
}
