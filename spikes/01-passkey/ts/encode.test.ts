import { Hex, P256, WebAuthn } from 'ox';
import { describe, expect, it } from 'vitest';
import { P256_N, toWebAuthnAuth } from './encode.js';

const privateKey = P256.randomPrivateKey();
const publicKey = P256.getPublicKey({ privateKey });
const challenge = Hex.random(32);
// No browser here, so the site a browser would report is passed in.
const site = { origin: 'https://countersign.example', rpId: 'countersign.example' };

function softwareSign() {
  const { metadata, payload } = WebAuthn.getSignPayload({ challenge, hash: true, ...site });
  const signature = P256.sign({ payload, privateKey });
  return { metadata, signature };
}

describe('toWebAuthnAuth', () => {
  it("maps ox's metadata and signature to OpenZeppelin's struct", () => {
    const { metadata, signature } = softwareSign();
    const auth = toWebAuthnAuth(metadata, signature);
    expect(auth).toEqual({
      r: Hex.padLeft(signature.r, 32),
      s: Hex.padLeft(signature.s, 32),
      challengeIndex: BigInt(metadata.clientDataJSON.indexOf('"challenge"')),
      typeIndex: BigInt(metadata.clientDataJSON.indexOf('"type"')),
      authenticatorData: metadata.authenticatorData,
      clientDataJSON: metadata.clientDataJSON,
    });
  });

  it('refuses a high-s signature instead of passing it on', () => {
    const { metadata, signature } = softwareSign();
    const highS = { ...signature, s: Hex.fromNumber(P256_N - Hex.toBigInt(signature.s)) };
    expect(() => toWebAuthnAuth(metadata, highS)).toThrow(/high-s/);
  });

  it('refuses metadata without challenge or type positions', () => {
    const { metadata, signature } = softwareSign();
    const noChallenge = { ...metadata, challengeIndex: undefined };
    expect(() => toWebAuthnAuth(noChallenge, signature)).toThrow(/challengeIndex/);
  });

  it('round trip: a software-signed payload verifies in ox like a browser one', () => {
    const { metadata, signature } = softwareSign();
    expect(WebAuthn.verify({ metadata, challenge, publicKey, signature })).toBe(true);
  });
});
