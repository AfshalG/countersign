import { keccak256, stringToHex, type Hex } from 'viem';

/**
 * The hashes every recorded decision carries (Slice 18). The checker computes the evidence hash to
 * sign a hold, the gateway to send a refusal, and anyone to verify a payment record, so there is
 * one definition, here.
 *
 * Canonical JSON is RFC 8785 (JCS): keys sorted by UTF-16 code units at every level, no
 * whitespace, numbers and strings exactly as ECMAScript's JSON.stringify writes them (the RFC
 * adopts ECMAScript's rules for both). So only the key order is added here, and no dependency is
 * needed for it (S18-2).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${String(value)} is not JSON`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    // As JSON.stringify does: an undefined or function element is written as null.
    return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && typeof v !== 'function')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`a ${typeof value} is not JSON`);
}

/** keccak256 of the evidence as canonical JSON: what a `Decision` on Monad carries. */
export const evidenceHash = (evidence: unknown): Hex =>
  keccak256(stringToHex(canonicalJson(evidence ?? null)));

/** A reason code as a `Decision` carries it: keccak256 of its text. */
export const reasonHash = (reason: string): Hex => keccak256(stringToHex(reason));
