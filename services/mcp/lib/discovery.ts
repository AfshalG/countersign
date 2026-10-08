import { generateProtectedResourceMetadata } from 'mcp-handler';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};

/**
 * RFC 9728: what an agent app reads after its first 401, naming this server as the resource and
 * WorkOS as where people sign in.
 */
export function discoveryDocument(issuer: string, resource: string) {
  return generateProtectedResourceMetadata({
    authServerUrls: [issuer],
    resourceUrl: resource,
    additionalMetadata: { bearer_methods_supported: ['header'], resource_name: 'Countersign' },
  });
}

const notConfigured = () =>
  Response.json(
    { error: 'sign-in is not configured on this server' },
    { status: 404, headers: CORS },
  );

/** GET /.well-known/oauth-protected-resource[/api/mcp] */
export function protectedResource(authkit: { issuer: string; audience: string } | undefined) {
  if (!authkit) return notConfigured();
  return Response.json(discoveryDocument(authkit.issuer, authkit.audience), {
    headers: { ...CORS, 'cache-control': 'max-age=3600' },
  });
}

/**
 * GET /.well-known/oauth-authorization-server: older MCP clients skip the document above and ask
 * the MCP server for the sign-in server's metadata. WorkOS's MCP guide passes AuthKit's through.
 */
export async function authorizationServer(
  issuer: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  if (!issuer) return notConfigured();
  try {
    const upstream = await fetchFn(`${issuer}/.well-known/oauth-authorization-server`);
    if (!upstream.ok) throw new Error(`AuthKit answered ${String(upstream.status)}`);
    return Response.json(await upstream.json(), {
      headers: { ...CORS, 'cache-control': 'max-age=3600' },
    });
  } catch (error) {
    console.error(JSON.stringify({ at: 'authorization-server', error: String(error) }));
    return Response.json(
      { error: 'the sign-in server did not answer' },
      { status: 502, headers: CORS },
    );
  }
}

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS });
