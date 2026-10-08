import { CASES, documentFor } from './documents';
import { asText, render } from './render';

/** A demo document as HTML, text (`?format=text`) or JSON (`?format=json`, with its case). */
export function respondWith(
  req: Request,
  id: string,
  kind: 'quote' | 'invoice' | 'checkout',
): Response {
  const url = new URL(req.url);
  const c = CASES.find((x) => x.id === id && x.kind === kind);
  if (!c) return new Response('Not found', { status: 404 });
  const d = documentFor(
    c.id,
    url.searchParams.get('account') ?? undefined,
    url.searchParams.get('run') ?? undefined,
  );
  const format = url.searchParams.get('format');
  const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (format === 'json') return Response.json(d, { headers });
  if (format === 'text')
    return new Response(asText(d), {
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    });
  return new Response(render(d), {
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
  });
}
