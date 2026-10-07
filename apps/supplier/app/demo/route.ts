import { demoIndex } from '../../lib/render';

export function GET(req: Request): Response {
  const account = new URL(req.url).searchParams.get('account') ?? undefined;
  return new Response(demoIndex(account), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
