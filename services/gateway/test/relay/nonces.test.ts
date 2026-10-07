import { describe, expect, it } from 'vitest';
import { NonceAllocator } from '../../src/relay/nonces.js';

describe('NonceAllocator', () => {
  it('hands out consecutive nonces per wallet, starting from the chain count', () => {
    const n = new NonceAllocator({ a: 5, b: 0 });
    expect([n.next('a'), n.next('a'), n.next('b'), n.next('a')]).toEqual([5, 6, 0, 7]);
  });

  it('never gives the same nonce twice, even across many wallets', () => {
    const n = new NonceAllocator({ a: 0, b: 0, c: 0 });
    const got = Array.from(
      { length: 300 },
      (_, i) => `${['a', 'b', 'c'][i % 3] ?? 'a'}:${String(n.next(['a', 'b', 'c'][i % 3] ?? 'a'))}`,
    );
    expect(new Set(got).size).toBe(300);
  });

  it('reuses a released nonce before handing out new ones, lowest first', () => {
    const n = new NonceAllocator({ a: 0 });
    [0, 1, 2, 3].forEach(() => n.next('a'));
    n.release('a', 2);
    n.release('a', 1);
    expect([n.next('a'), n.next('a'), n.next('a')]).toEqual([1, 2, 4]);
  });

  it('refuses an unknown wallet instead of guessing a nonce', () => {
    const n = new NonceAllocator({ a: 0 });
    expect(() => n.next('zz')).toThrow(/unknown wallet/);
  });
});
