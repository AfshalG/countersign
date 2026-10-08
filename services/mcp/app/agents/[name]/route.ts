import { registrationOf } from '../../../lib/agents';

/** An agent's ERC-8004 registration file, at the URI its registry entry names. */
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const file = registrationOf(name.replace(/\.json$/, ''));
  if (!file) return Response.json({ error: 'unknown agent' }, { status: 404 });
  return Response.json(file, {
    headers: { 'access-control-allow-origin': '*', 'cache-control': 'max-age=300' },
  });
}
