import { loadEnv } from '@countersign/shared';
import type { Hex } from 'viem';
import { z } from 'zod';

// The spike runs locally only; its settings come from the repo's git-ignored .env.
process.loadEnvFile(new URL('../../../.env', import.meta.url));

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((k) => k as Hex);

export const settings = loadEnv(
  z.object({
    MONAD_RPC_URL: z.url(),
    MONAD_WS_URL: z.url(),
    DEPLOYER_PRIVATE_KEY: privateKey,
    SPIKE3_CHECKER_PRIVATE_KEY: privateKey,
    RELAYER_PRIVATE_KEYS: z
      .string()
      .transform((v) => v.split(',').map((k) => k.trim()))
      .pipe(z.array(privateKey).min(8)),
  }),
);
