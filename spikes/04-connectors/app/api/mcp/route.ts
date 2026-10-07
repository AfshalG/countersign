import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { z } from 'zod';
import { decideAccess, RateLimiter } from '../../../lib/auth';
import { checkPayment, checkPaymentInput } from '../../../lib/tools';

const mcp = createMcpHandler(
  (server) => {
    server.registerTool(
      'check_payment',
      {
        title: 'Check a payment',
        description:
          'Checks a payment an agent is about to make against what the business approved: the supplier, ' +
          'its address on file and the order limit. Returns settled, or held with the reason and a link ' +
          'where a person approves or refuses. Demo rules only; no money moves.',
        inputSchema: checkPaymentInput,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      (args) => {
        const result = checkPayment(args);
        return Promise.resolve({
          content: [
            { type: 'text' as const, text: `${result.status.toUpperCase()}: ${result.message}` },
          ],
        });
      },
    );
    server.registerTool(
      'connection_info',
      {
        title: 'Connection info',
        description:
          'Reports whether this connection is signed in and the server time. Used to confirm an agent app is connected.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      (_args, ctx) => {
        const signedIn = ctx.http?.authInfo !== undefined;
        return Promise.resolve({
          content: [
            {
              type: 'text' as const,
              text: `Connected to the Countersign connector spike (${signedIn ? 'signed in with a token' : 'open door, demo tools only'}) at ${new Date().toISOString()}.`,
            },
          ],
        });
      },
    );
  },
  { serverInfo: { name: 'countersign-connector-spike', version: '0.0.0' } },
);

// Token door: the bearer token becomes authInfo for the tools; no token is allowed
// (the open door), because decideAccess has already rejected wrong tokens.
const verifyToken = (_req: Request, bearer?: string): AuthInfo | undefined =>
  bearer ? { token: bearer, clientId: 'connector-test-token', scopes: [] } : undefined;
const withAuth = withMcpAuth(mcp, verifyToken, { required: false });

const openDoorLimit = new RateLimiter(60, 60_000);

async function handle(req: Request): Promise<Response> {
  const access = decideAccess(
    req.headers.get('authorization') ?? undefined,
    process.env.CONNECTOR_TEST_TOKEN,
  );
  // One line per request in the Vercel logs, so each agent app's calls can be identified.
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      door: access.door,
      method: req.method,
      userAgent: req.headers.get('user-agent') ?? 'unknown',
    }),
  );
  if (access.door === 'reject') {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer error="invalid_token"',
      },
    });
  }
  if (access.door === 'open') {
    const caller = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!openDoorLimit.allow(caller)) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      });
    }
  }
  return withAuth(req);
}

export { handle as GET, handle as POST, handle as DELETE };
