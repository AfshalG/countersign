import { describe, expect, it } from 'vitest';
import { nextEndpoint, stalledNonce, type LaneRecord } from '../../src/relay/failover.js';

const rec = (nonce: number, over: Partial<LaneRecord> = {}): LaneRecord => ({
  nonce,
  lastAcceptedAt: undefined,
  included: false,
  failed: false,
  ...over,
});

describe('stalledNonce', () => {
  it('finds the lowest pending nonce once it has waited too long', () => {
    const lane = [
      rec(1, { included: true }),
      rec(2, { lastAcceptedAt: 1_000 }),
      rec(3, { lastAcceptedAt: 1_100 }),
    ];
    expect(stalledNonce(lane, 4_100, 3_000)).toBe(2);
  });

  it('waits while the lowest pending nonce is still within its time', () => {
    const lane = [rec(2, { lastAcceptedAt: 1_000 }), rec(3, { lastAcceptedAt: 1_100 })];
    expect(stalledNonce(lane, 3_900, 3_000)).toBeUndefined();
  });

  it('waits while the lowest pending nonce has not been accepted yet', () => {
    const lane = [rec(2), rec(3, { lastAcceptedAt: 0 })];
    expect(stalledNonce(lane, 10_000, 3_000)).toBeUndefined();
  });

  it('skips failed ones and is quiet when everything is in', () => {
    expect(
      stalledNonce([rec(1, { failed: true }), rec(2, { included: true })], 10_000, 3_000),
    ).toBeUndefined();
  });
});

describe('nextEndpoint', () => {
  it('moves to the next endpoint that is not set aside', () => {
    expect(nextEndpoint(0, [0, 5_000, 0], 1_000)).toBe(2);
  });

  it('wraps around', () => {
    expect(nextEndpoint(2, [0, 0, 0], 1_000)).toBe(0);
  });

  it('takes the next one anyway when every other endpoint is set aside', () => {
    expect(nextEndpoint(0, [9_000, 9_000, 9_000], 1_000)).toBe(1);
  });
});
