/**
 * Writes software-signed WebAuthn vectors for the Foundry tests. Deterministic:
 * a fixed test-only key and no signing entropy, so the file only changes when
 * this script does. Run: pnpm fixtures
 */
import { writeFileSync } from 'node:fs';
import { Hash, Hex, P256, WebAuthn } from 'ox';
import { P256_N, toWebAuthnAuth, type WebAuthnAuth } from './encode.js';

const site = { origin: 'https://countersign.example', rpId: 'countersign.example' };
// Test-only keys, derived from fixed labels. Never used for anything real.
const privateKey = Hash.sha256(Hex.fromString('countersign spike 01 test key'));
const otherKey = Hash.sha256(Hex.fromString('countersign spike 01 other key'));
const challenge = Hash.sha256(Hex.fromString('countersign spike 01 challenge'));

function signDigest(authenticatorData: Hex.Hex, clientDataJSON: string) {
  const digest = Hash.sha256(
    Hex.concat(authenticatorData, Hash.sha256(Hex.fromString(clientDataJSON))),
  );
  return P256.sign({ payload: digest, privateKey, extraEntropy: false });
}

function signed(options: { flag?: number; type?: 'webauthn.get' | 'webauthn.create' }) {
  const authenticatorData = WebAuthn.getAuthenticatorData({
    rpId: site.rpId,
    ...(options.flag === undefined ? {} : { flag: options.flag }),
  });
  const clientDataJSON = WebAuthn.getClientDataJSON({
    challenge,
    origin: site.origin,
    ...(options.type === undefined ? {} : { type: options.type }),
  });
  const metadata = {
    authenticatorData,
    clientDataJSON,
    challengeIndex: clientDataJSON.indexOf('"challenge"'),
    typeIndex: clientDataJSON.indexOf('"type"'),
  };
  return toWebAuthnAuth(metadata, signDigest(authenticatorData, clientDataJSON));
}

const valid = signed({});
const highS: WebAuthnAuth = {
  ...valid,
  s: Hex.fromNumber(P256_N - Hex.toBigInt(valid.s), { size: 32 }),
};

const publicKey = P256.getPublicKey({ privateKey });
const other = P256.getPublicKey({ privateKey: otherKey });
const asJson = (a: WebAuthnAuth) => ({
  ...a,
  challengeIndex: Number(a.challengeIndex),
  typeIndex: Number(a.typeIndex),
});

const fixtures = {
  qx: Hex.padLeft(publicKey.x, 32),
  qy: Hex.padLeft(publicKey.y, 32),
  otherQx: Hex.padLeft(other.x, 32),
  otherQy: Hex.padLeft(other.y, 32),
  challenge,
  valid: asJson(valid),
  // User present, not verified: a tap without Face ID or a PIN.
  noUV: asJson(signed({ flag: 0x01 })),
  // A registration signature replayed as an approval.
  createType: asJson(signed({ type: 'webauthn.create' })),
  highS: asJson(highS),
};

const out = new URL('../test/fixtures/vectors.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
