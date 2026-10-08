import { kalibreHome } from '../lib/render';

export function GET(): Response {
  return new Response(kalibreHome(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
