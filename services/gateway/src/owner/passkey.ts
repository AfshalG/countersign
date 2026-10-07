import { createHash, createPublicKey, verify } from 'node:crypto';
import { hexToBytes, type Hex } from 'viem';
import type { WebAuthnAuth } from '../chain/types.js';

/**
 * Checks a WebAuthn assertion against an account's owner key off chain, for owner decisions that
 * change nothing on chain (refusing a proposal). The same checks as OpenZeppelin's WebAuthn.verify,
 * which the account runs for everything else: user presence and user verification set in the
 * authenticator data, and a P-256 signature over the authenticator data followed by the SHA-256
 * of the client data. The challenge and the ceremony type are checked earlier, by fromBrowser.
 */
export function ownerSigned(key: { qx: Hex; qy: Hex }, auth: WebAuthnAuth): boolean {
  const authenticatorData = hexToBytes(auth.authenticatorData);
  const flags = authenticatorData[32] ?? 0;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return false; // UP and UV
  const publicKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(hexToBytes(key.qx)).toString('base64url'),
      y: Buffer.from(hexToBytes(key.qy)).toString('base64url'),
    },
    format: 'jwk',
  });
  const message = Buffer.concat([
    authenticatorData,
    createHash('sha256').update(auth.clientDataJSON, 'utf8').digest(),
  ]);
  const signature = Buffer.concat([hexToBytes(auth.r), hexToBytes(auth.s)]);
  try {
    return verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}
