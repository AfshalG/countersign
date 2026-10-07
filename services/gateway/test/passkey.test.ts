import { createHash, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { P256_N, SoftPasskey } from '../scripts/passkey.js';

const digest = `0x${'ab'.repeat(32)}` as const;
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const bytes = (hex: string) => Buffer.from(hex.slice(2), 'hex');

describe('SoftPasskey', () => {
  const passkey = SoftPasskey.fromScalar(`0x${'11'.repeat(32)}`);

  it('signs a webauthn.get assertion whose challenge is the digest', () => {
    const auth = passkey.sign(digest);
    const json = auth.clientDataJSON;
    expect(json.slice(Number(auth.typeIndex))).toMatch(/^"type":"webauthn\.get"/);
    expect(json.slice(Number(auth.challengeIndex))).toMatch(
      new RegExp(`^"challenge":"${bytes(digest).toString('base64url')}"`),
    );
    expect(JSON.parse(json)).toMatchObject({ type: 'webauthn.get' });
  });

  it('marks the user as present and verified (Face ID, fingerprint or PIN)', () => {
    const data = bytes(passkey.sign(digest).authenticatorData);
    expect(data.length).toBe(37);
    expect(data.subarray(0, 32)).toEqual(sha256('countersign.test'));
    expect(data[32]).toBe(0x05);
  });

  it('signs sha256(authenticatorData || sha256(clientDataJSON)) with a low-s signature', () => {
    for (let i = 0; i < 20; i++) {
      const auth = passkey.sign(digest);
      expect(BigInt(auth.s)).toBeLessThanOrEqual(P256_N / 2n);
      const message = Buffer.concat([bytes(auth.authenticatorData), sha256(auth.clientDataJSON)]);
      const signature = Buffer.concat([bytes(auth.r), bytes(auth.s)]);
      expect(
        verify('sha256', message, { key: passkey.publicKey, dsaEncoding: 'ieee-p1363' }, signature),
      ).toBe(true);
    }
  });

  it('gives the public key as the account stores it (32-byte x and y)', () => {
    const jwk = passkey.publicKey.export({ format: 'jwk' });
    expect(passkey.qx).toBe(`0x${Buffer.from(String(jwk.x), 'base64url').toString('hex')}`);
    expect(passkey.qy).toBe(`0x${Buffer.from(String(jwk.y), 'base64url').toString('hex')}`);
    expect(passkey.qx).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('refuses a key outside the curve order and a digest that is not 32 bytes', () => {
    expect(() => SoftPasskey.fromScalar('0x00')).toThrow(/out of range/);
    expect(() => SoftPasskey.fromScalar(`0x${P256_N.toString(16)}`)).toThrow(/out of range/);
    expect(() => passkey.sign('0x1234')).toThrow(/32 bytes/);
  });
});
