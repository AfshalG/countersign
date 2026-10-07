import { z } from 'zod';
import { loadEnv, monadChainId } from '@countersign/shared';

/**
 * Read on the first request, not at build time: the build never needs the secrets. One account
 * in hosted mode until Slice 13 adds sign-in and per-account keys (S12-2).
 */
export function loadSettings(source?: Record<string, string | undefined>) {
  return loadEnv(
    z.object({
      GATEWAY_URL: z.url(),
      GATEWAY_TOKEN: z.string().min(24),
      MONAD_CHAIN_ID: monadChainId,
      ACCOUNT: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      // Hosted mode: the agent key for ACCOUNT, held here on the account's behalf. Testnet only.
      AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      // What MCP clients send (Claude Code, Codex, API agents); OAuth replaces it in Slice 13.
      MCP_TOKEN: z.string().min(24),
    }),
    source,
  );
}
