import { describe, expect, it } from 'vitest';
import { decideAccess, RateLimiter } from './auth.js';

const TOKEN = 'test-token-0123456789abcdef';

describe('decideAccess', () => {
  it('lets a request without a token through the open door', () => {
    expect(decideAccess(undefined, TOKEN)).toEqual({ door: 'open' });
  });

  it('lets the right bearer token through the token door', () => {
    expect(decideAccess(`Bearer ${TOKEN}`, TOKEN)).toEqual({ door: 'token' });
  });

  it.each([
    ['a wrong token', 'Bearer nope'],
    ['a malformed header', 'Basic abc'],
    ['an empty bearer', 'Bearer '],
  ])('refuses %s instead of treating it as open', (_label, header) => {
    expect(decideAccess(header, TOKEN)).toEqual({ door: 'reject' });
  });

  it('refuses every token when no token is configured', () => {
    expect(decideAccess(`Bearer ${TOKEN}`, undefined)).toEqual({ door: 'reject' });
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per window, then refuses', () => {
    const limiter = new RateLimiter(3, 60_000);
    const t = 1_000_000;
    expect([1, 2, 3, 4].map(() => limiter.allow('a', t))).toEqual([true, true, true, false]);
  });

  it('counts each caller separately and resets after the window', () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('b', 0)).toBe(true);
    expect(limiter.allow('a', 500)).toBe(false);
    expect(limiter.allow('a', 1_500)).toBe(true);
  });
});
