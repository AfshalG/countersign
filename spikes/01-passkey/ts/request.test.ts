import { describe, expect, it } from 'vitest';
import vectors from '../test/fixtures/vectors.json' with { type: 'json' };
import { parseRecordRequest } from './request.js';

const good = {
  challenge: vectors.challenge,
  auth: vectors.valid,
  qx: vectors.qx,
  qy: vectors.qy,
  mode: 'full',
};

describe('parseRecordRequest', () => {
  it('accepts a well-formed request and converts indexes to bigint', () => {
    const parsed = parseRecordRequest(good);
    expect(parsed.mode).toBe(0);
    expect(parsed.auth.challengeIndex).toBe(23n);
    expect(parsed.auth.clientDataJSON).toBe(vectors.valid.clientDataJSON);
  });

  it.each([
    ['native', 1],
    ['solidity', 2],
  ])('maps mode %s to %i', (mode, value) => {
    expect(parseRecordRequest({ ...good, mode }).mode).toBe(value);
  });

  it.each([
    ['a non-object', 'hello'],
    ['an unknown mode', { ...good, mode: 'fast' }],
    ['a short qx', { ...good, qx: '0x1234' }],
    ['r that is not hex', { ...good, auth: { ...good.auth, r: 'zz' } }],
    ['a negative index', { ...good, auth: { ...good.auth, typeIndex: -1 } }],
    [
      'oversized client data',
      { ...good, auth: { ...good.auth, clientDataJSON: 'x'.repeat(5000) } },
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => parseRecordRequest(body)).toThrow();
  });
});
