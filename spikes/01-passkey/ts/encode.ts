import { Hex, type Signature, type WebAuthn } from 'ox';

/** Order of the P-256 curve. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** OpenZeppelin's `WebAuthn.WebAuthnAuth`, field for field, in viem's ABI types. */
export type WebAuthnAuth = {
  r: Hex.Hex;
  s: Hex.Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex.Hex;
  clientDataJSON: string;
};

/**
 * Turns ox's WebAuthn output into the struct OpenZeppelin verifies.
 *
 * OpenZeppelin rejects signatures with `s` above N/2 (malleability). ox
 * already flips browser signatures to low-s, so a high-s value here means
 * something upstream changed; we refuse it rather than send a payment
 * approval that is certain to fail on chain.
 */
export function toWebAuthnAuth(
  metadata: WebAuthn.SignMetadata,
  signature: Signature.Signature<false>,
): WebAuthnAuth {
  if (Hex.toBigInt(signature.s) > P256_N / 2n) {
    throw new Error('high-s signature: OpenZeppelin would reject it');
  }
  const { challengeIndex, typeIndex } = metadata;
  if (challengeIndex === undefined || challengeIndex < 0) {
    throw new Error('metadata has no challengeIndex');
  }
  if (typeIndex === undefined || typeIndex < 0) {
    throw new Error('metadata has no typeIndex');
  }
  return {
    r: Hex.padLeft(signature.r, 32),
    s: Hex.padLeft(signature.s, 32),
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    authenticatorData: metadata.authenticatorData,
    clientDataJSON: metadata.clientDataJSON,
  };
}
