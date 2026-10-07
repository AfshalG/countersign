import { hostedA2A } from '../../../lib/a2a-hosted';

/** The A2A door's JSON-RPC endpoint (Slice 19 part B). */
export async function POST(req: Request): Promise<Response> {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      door: 'a2a',
      version: req.headers.get('a2a-version') ?? '0.3',
      userAgent: req.headers.get('user-agent') ?? 'unknown',
    }),
  );
  return hostedA2A().rpc(req);
}

// A payment waits up to 10 s for Monad to finalize.
export const maxDuration = 30;
