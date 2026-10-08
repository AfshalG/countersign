import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { P256_N, SoftPasskey } from '../scripts/passkey.js';
import { AssertionError, fromBrowser } from '../src/api/webauthn.js';

const passkey = SoftPasskey.fromScalar(`0x${'22'.repeat(32)}`);
const digest = keccak256(toHex('a vault payment digest'));
const hexToB64url = (hex: string) => Buffer.from(hex.slice(2), 'hex').toString('base64url');
const int = (hex: string) => {
  // a DER INTEGER: big-endian, a leading zero byte when the top bit is set
  let bytes = Buffer.from(hex.slice(2), 'hex');
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] ?? 0) < 0x80) bytes = bytes.subarray(1);
  if ((bytes[0] ?? 0) >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
};
const der = (r: string, s: string) => {
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

describe('the passkey assertion as a browser gives it', () => {
  const signed = passkey.sign(digest);

  it('takes ox’s shape (hex authenticator data, the client data JSON, r and s) and finds the indexes', () => {
    const auth = fromBrowser(
      {
        authenticatorData: signed.authenticatorData,
        clientDataJSON: signed.clientDataJSON,
        signature: { r: signed.r, s: signed.s },
      },
      digest,
    );
    expect(auth).toEqual(signed);
  });

  it('takes navigator.credentials.get’s raw shape: base64url fields and a DER signature', () => {
    const auth = fromBrowser(
      {
        authenticatorData: hexToB64url(signed.authenticatorData),
        clientDataJSON: Buffer.from(signed.clientDataJSON).toString('base64url'),
        signature: der(signed.r, signed.s).toString('base64url'),
      },
      digest,
    );
    expect(auth).toEqual(signed);
  });

  it('turns a high-s signature into the low-s one the contract accepts', () => {
    const high = `0x${(P256_N - BigInt(signed.s)).toString(16).padStart(64, '0')}`;
    const auth = fromBrowser(
      {
        authenticatorData: signed.authenticatorData,
        clientDataJSON: signed.clientDataJSON,
        signature: { r: signed.r, s: high },
      },
      digest,
    );
    expect(auth.s).toBe(signed.s);
  });

  it('refuses an assertion over a different challenge before anything is sent', () => {
    expect(() =>
      fromBrowser(
        {
          authenticatorData: signed.authenticatorData,
          clientDataJSON: signed.clientDataJSON,
          signature: { r: signed.r, s: signed.s },
        },
        keccak256(toHex('another action')),
      ),
    ).toThrow(new AssertionError('challenge_mismatch', 'the passkey signed a different action'));
  });

  it('refuses a ceremony that is not webauthn.get, and data that is not an assertion', () => {
    const create = signed.clientDataJSON.replace('webauthn.get', 'webauthn.create');
    expect(() =>
      fromBrowser(
        {
          authenticatorData: signed.authenticatorData,
          clientDataJSON: create,
          signature: { r: signed.r, s: signed.s },
        },
        digest,
      ),
    ).toThrow(/webauthn.get/);
    expect(() =>
      fromBrowser(
        {
          authenticatorData: '0x00',
          clientDataJSON: signed.clientDataJSON,
          signature: { r: signed.r, s: signed.s },
        },
        digest,
      ),
    ).toThrow(/authenticator data/);
    expect(() =>
      fromBrowser(
        {
          authenticatorData: signed.authenticatorData,
          clientDataJSON: signed.clientDataJSON,
          signature: '0x3000',
        },
        digest,
      ),
    ).toThrow(/signature/);
  });
});
