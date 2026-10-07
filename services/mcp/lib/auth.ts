import { timingSafeEqual } from 'node:crypto';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/server';

/**
 * The static token compared in constant time. Unlike Slice 4's spike there is no open door:
 * these tools move (testnet) money, so a missing or wrong token is refused before any tool runs.
 */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** WorkOS AuthKit, which signs people in for agent apps that use OAuth (Slice 13). */
export type AuthKit = {
  /** `https://<AuthKit domain>`, the `iss` of every access token. */
  issuer: string;
  /**
   * The MCP endpoint's public URL, the `aud` every token must name. Fixed by configuration,
   * never taken from the request: a Host header chosen by the caller would let a token minted
   * for another server pass here.
   */
  audience: string;
  /** WorkOS's signing keys (`<issuer>/oauth2/jwks`; a local set in tests). */
  keys: JWTVerifyGetKey;
};

/**
 * Who is calling: the static token (Claude Code, Codex, scripts, Muse) or a WorkOS access token
 * (grok.com, ChatGPT and dots, claude.ai). Anything else is undefined, which the handler answers
 * with 401 and where to sign in, whether the token is missing, forged, expired or for another
 * server: an agent app's response to all of them is the same, sign in again.
 */
export function accessVerifier(mcpToken: string, authkit?: AuthKit) {
  return async (_req: Request, bearer?: string): Promise<AuthInfo | undefined> => {
    if (!bearer) return undefined;
    if (sameSecret(bearer, mcpToken))
      return { token: bearer, clientId: 'mcp-token', scopes: [], extra: { via: 'token' } };
    if (!authkit) return undefined;
    try {
      const { payload } = await jwtVerify(bearer, authkit.keys, {
        issuer: authkit.issuer,
        audience: authkit.audience,
        algorithms: ['RS256'], // WorkOS signs with RS256; pinning it rules out algorithm swaps
      });
      return {
        token: bearer,
        clientId: typeof payload.client_id === 'string' ? payload.client_id : 'unknown',
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
        ...(payload.exp === undefined ? {} : { expiresAt: payload.exp }),
        resource: new URL(authkit.audience),
        extra: { via: 'workos', userId: payload.sub },
      };
    } catch {
      return undefined;
    }
  };
}
