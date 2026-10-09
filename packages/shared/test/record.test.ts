import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import { canonicalJson, evidenceHash, reasonHash } from '../src/record.js';

/**
 * Slice 18: the evidence hash every decision carries on Monad. The checker computes it to sign,
 * the gateway to send, and anyone to verify a record, so it must be the same everywhere: keccak256
 * of canonical JSON (RFC 8785: keys sorted, no whitespace).
 */
describe('canonical JSON', () => {
  it('sorts keys at every level, keeps array order, and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('writes numbers and strings as RFC 8785 does (its own examples)', () => {
    expect(canonicalJson({ n: [333333333.3333333, 1e30, 4.5, 0.002, 1e-7, -0] })).toBe(
      '{"n":[333333333.3333333,1e+30,4.5,0.002,1e-7,0]}',
    );
    expect(canonicalJson({ s: '€$\u000f\nA\'B"\\\\"/' })).toBe(
      '{"s":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units, as RFC 8785 says', () => {
    // Written as escapes: a composed letter and its decomposed form look alike in source.
    expect(canonicalJson({ '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '\u00e9': 5 })).toBe(
      '{"\\r":2,"1":4,"\u00e9":5,"\u20ac":1,"\ufb33":3}',
    );
  });

  it('leaves out undefined fields, as JSON does, and refuses what JSON cannot carry', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/not JSON/);
    expect(() => canonicalJson({ n: 10n })).toThrow(/not JSON/);
  });
});

describe('the evidence hash and the reason hash', () => {
  it('hashes the canonical JSON, so the same evidence in any key order is the same hash', () => {
    const a = { checker: 'countersign-checker/1', findings: [{ check: 'read', ok: true }] };
    const b = { findings: [{ ok: true, check: 'read' }], checker: 'countersign-checker/1' };
    expect(evidenceHash(a)).toBe(evidenceHash(b));
    expect(evidenceHash(a)).toBe(keccak256(stringToHex(canonicalJson(a))));
    expect(evidenceHash({ ...a, ms: 1 })).not.toBe(evidenceHash(a));
  });

  it('hashes a reason code as its text, and no evidence as JSON null', () => {
    expect(reasonHash('amount_mismatch')).toBe(keccak256(stringToHex('amount_mismatch')));
    expect(evidenceHash(null)).toBe(keccak256(stringToHex('null')));
  });
});
