import { hostedA2A } from '../../../lib/a2a-hosted';

// Read at request time: the settings are runtime secrets, never baked in at build.
export const dynamic = 'force-dynamic';

/** The Agent Card A2A clients fetch first. */
export function GET(): Response {
  return hostedA2A().card();
}
