import { createRemoteJWKSet } from 'jose';
import { createServer } from './server';
import { authkitSettings, loadSettings } from './settings';

/** The deployed server's settings and handler, built on the first request and kept. */
let built:
  | { handler: (req: Request) => Promise<Response>; authkit?: { issuer: string; audience: string } }
  | undefined;

export function hosted() {
  if (!built) {
    const s = loadSettings();
    const authkit = authkitSettings(s);
    built = {
      handler: createServer({
        gatewayUrl: s.GATEWAY_URL,
        gatewayToken: s.GATEWAY_TOKEN,
        chainId: s.MONAD_CHAIN_ID,
        account: s.ACCOUNT as `0x${string}`,
        agentKey: s.AGENT_PRIVATE_KEY as `0x${string}`,
        mcpToken: s.MCP_TOKEN,
        ...(authkit
          ? {
              authkit: {
                ...authkit,
                // jose caches WorkOS's keys and refetches when a token names an unknown one.
                keys: createRemoteJWKSet(new URL(`${authkit.issuer}/oauth2/jwks`)),
              },
            }
          : {}),
        log: (line) => {
          console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
        },
      }),
      ...(authkit ? { authkit } : {}),
    };
  }
  return built;
}
