import { respondWith } from '../../../lib/respond';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return respondWith(req, (await ctx.params).id, 'invoice');
}
