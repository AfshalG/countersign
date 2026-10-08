import { z } from 'zod';
import { loadEnv, monadChainId } from '@countersign/shared';

/**
 * Read on the first request, not at build time: the build never needs the secrets. One account
 * in hosted mode, also for people signed in through WorkOS, until judge mode (Slice 9 part 4).
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
      // What MCP clients without sign-in send (Claude Code, Codex, scripts, Muse).
      MCP_TOKEN: z.string().min(24),
      // Slice 13, sign-in for agent apps (grok.com, ChatGPT and dots, claude.ai): both or neither.
      AUTHKIT_DOMAIN: z
        .string()
        .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
        .optional(),
      // This endpoint's public URL: WorkOS's resource indicator and every token's audience.
      MCP_PUBLIC_URL: z.url().optional(),
    }),
    source,
  );
}

/** WorkOS sign-in, when configured: a half-configured sign-in is a mistake, not an off switch. */
export function authkitSettings(settings: ReturnType<typeof loadSettings>) {
  const { AUTHKIT_DOMAIN: domain, MCP_PUBLIC_URL: audience } = settings;
  if (domain === undefined && audience === undefined) return undefined;
  if (domain === undefined || audience === undefined)
    throw new Error('Set both AUTHKIT_DOMAIN and MCP_PUBLIC_URL to turn sign-in on, or neither');
  return { issuer: `https://${domain}`, audience };
}
