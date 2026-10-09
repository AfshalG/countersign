import { GATEWAY } from '../../../../lib/gateway';

/**
 * The run board's numbers, from the gateway's public run page (`/r/{id}?format=json`, no token).
 * Through this app's server because that page sends no CORS header (S11-3).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(id))
    return Response.json({ error: 'malformed', message: 'not a run id' }, { status: 400 });
  try {
    const res = await fetch(`${GATEWAY}/r/${id}?format=json`, { cache: 'no-store' });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'gateway_unavailable' }, { status: 502 });
  }
}
