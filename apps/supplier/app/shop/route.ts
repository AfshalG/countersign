import { shopHome } from '../../lib/render';

export function GET(req: Request): Response {
  const params = new URL(req.url).searchParams;
  const account = params.get('account') ?? undefined;
  const run = params.get('run') ?? undefined;
  return new Response(shopHome(account, run), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
