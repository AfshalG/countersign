import { timingSafeEqual } from 'node:crypto';

/**
 * The bearer token every MCP client must send. Unlike Slice 4's spike there is no open door:
 * these tools move (testnet) money. A missing or wrong token is refused before any tool runs.
 */
export function tokenMatches(authorization: string | null, expected: string): boolean {
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]?.trim();
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
