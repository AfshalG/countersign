import { shopHome } from '../../lib/render';

export function GET(req: Request): Response {
  const account = new URL(req.url).searchParams.get('account') ?? undefined;
  return new Response(shopHome(account), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
