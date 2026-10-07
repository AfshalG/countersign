import { createRemoteJWKSet } from 'jose';
import { createA2A } from './a2a';
import { authkitSettings, loadSettings } from './settings';

/** The deployed A2A door, built on the first request from the same settings as the MCP server. */
let built: ReturnType<typeof createA2A> | undefined;

export function hostedA2A() {
  if (!built) {
    const s = loadSettings();
    const authkit = authkitSettings(s);
    built = createA2A({
      gatewayUrl: s.GATEWAY_URL,
      gatewayToken: s.GATEWAY_TOKEN,
      chainId: s.MONAD_CHAIN_ID,
      account: s.ACCOUNT as `0x${string}`,
      agentKey: s.AGENT_PRIVATE_KEY as `0x${string}`,
      mcpToken: s.MCP_TOKEN,
      publicUrl: s.MCP_PUBLIC_URL
        ? new URL(s.MCP_PUBLIC_URL).origin
        : 'https://countersign-mcp.vercel.app',
      ...(authkit
        ? {
            authkit: {
              ...authkit,
              keys: createRemoteJWKSet(new URL(`${authkit.issuer}/oauth2/jwks`)),
            },
          }
        : {}),
    });
  }
  return built;
}
