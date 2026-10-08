import { addressFileFor } from '../../../lib/documents';

// Each supplier's address file on its own host (Slice 15): Kalibre Studio's exactly as in Slice 2
// (the Primus proof pins it), Northwind Prints' on its own domain. Read per request: the host
// decides which supplier's site this is.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return new Response(addressFileFor(request.headers.get('host') ?? undefined), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
