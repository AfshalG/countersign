import type { Hex } from 'viem';
import { OwnerActionError } from './send.js';

/**
 * A passkey's public key as the phone sends it: `{ x, y }` as hex (what `ox` gives), or the
 * SubjectPublicKeyInfo the browser's `response.getPublicKey()` returns (base64url; for P-256 its
 * last 65 bytes are 0x04 ‖ x ‖ y). Whether the point is on the curve is the contract's check
 * (InvalidOwnerKey).
 */
export function publicKeyOf(input: {
  x?: string | undefined;
  y?: string | undefined;
  spki?: string | undefined;
}): {
  qx: Hex;
  qy: Hex;
} {
  const word = (v: string | undefined, name: string): Hex => {
    if (v === undefined || !/^0x[0-9a-fA-F]{1,64}$/.test(v))
      throw new OwnerActionError(400, 'invalid_public_key', `${name} must be 32-byte hex`);
    return `0x${v.slice(2).padStart(64, '0')}`;
  };
  if (input.spki !== undefined) {
    const bytes = Buffer.from(input.spki, 'base64url');
    if (bytes.length < 65 || bytes[bytes.length - 65] !== 0x04)
      throw new OwnerActionError(400, 'invalid_public_key', 'not an uncompressed P-256 public key');
    const point = bytes.subarray(bytes.length - 64);
    return {
      qx: `0x${point.subarray(0, 32).toString('hex')}`,
      qy: `0x${point.subarray(32).toString('hex')}`,
    };
  }
  return { qx: word(input.x, 'x'), qy: word(input.y, 'y') };
}
