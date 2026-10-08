import { timingSafeEqual } from 'node:crypto';

export type Access = { door: 'open' } | { door: 'token' } | { door: 'reject' };

/**
 * Two doors for the spike. No Authorization header: the open door (web agent apps
 * that connect without sign-in; demo tools only). A header: it must be exactly our
 * bearer token, otherwise reject. A wrong token is never downgraded to the open
 * door, so a client that thinks it is signed in learns that it is not.
 */
export function decideAccess(
  authorization: string | undefined,
  expectedToken: string | undefined,
): Access {
  if (authorization === undefined || authorization === '') return { door: 'open' };
  const match = /^Bearer (.+)$/.exec(authorization);
  const given = match?.[1]?.trim();
  if (!expectedToken || !given) return { door: 'reject' };
  const a = Buffer.from(given);
  const b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b) ? { door: 'token' } : { door: 'reject' };
}

/**
 * Fixed-window limit per caller. In memory, so per server instance: enough to stop
 * a burst against a spike, not a production limiter (Vercel's firewall is for that).
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }
}
