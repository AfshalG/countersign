import { ADDRESS_FILE } from '../../../lib/documents';

// Kalibre Studio's address file, served exactly as in Slice 2 (the Primus proof pins it).
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(ADDRESS_FILE, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
