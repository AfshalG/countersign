import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ecdsaSign,
  type KeyObject,
} from 'node:crypto';
import type { Hex } from 'viem';
import type { WebAuthnAuth } from '../src/chain/types.js';

/** The P-256 group order. OpenZeppelin's P256.verify refuses s above half of it. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const RP_ID = 'countersign.test';
const ORIGIN = 'https://countersign.test';
const FLAGS_UP_UV = 0x05; // user present, user verified (Face ID, fingerprint, PIN)

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const hex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/**
 * A software passkey for testnet runs and tests. It signs WebAuthn assertions the same way
 * `contracts/test/helpers/PasskeySigner.sol` does, which is how a phone's passkey signed in
 * Slice 1: the challenge is the 32-byte EIP-712 digest, and the signature covers
 * sha256(authenticatorData || sha256(clientDataJSON)). Never used to hold real money; the
 * owner's real passkey lives on their phone.
 */
export class SoftPasskey {
  private constructor(
    private readonly privateKey: KeyObject,
    readonly publicKey: KeyObject,
    readonly qx: Hex,
    readonly qy: Hex,
  ) {}

  /** From the private scalar (as in SLICE5_OWNER_P256_KEY). */
  static fromScalar(scalar: string): SoftPasskey {
    const d = BigInt(scalar);
    if (d <= 0n || d >= P256_N) throw new Error('P-256 private key out of range');
    const dBytes = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(dBytes);
    const point = ecdh.getPublicKey(); // 0x04 || x || y
    const x = point.subarray(1, 33);
    const y = point.subarray(33, 65);
    const privateKey = createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: dBytes.toString('base64url'),
        x: x.toString('base64url'),
        y: y.toString('base64url'),
      },
    });
    return new SoftPasskey(
      privateKey,
      createPublicKey(privateKey),
      `0x${x.toString('hex')}`,
      `0x${y.toString('hex')}`,
    );
  }

  /** A user-verified `webauthn.get` assertion over `digest`, with a low-s signature. */
  sign(digest: Hex): WebAuthnAuth {
    if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error('the digest must be 32 bytes');
    const challenge = Buffer.from(digest.slice(2), 'hex').toString('base64url');
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${challenge}","origin":"${ORIGIN}","crossOrigin":false}`;
    const authenticatorData = Buffer.concat([
      sha256(RP_ID),
      Buffer.from([FLAGS_UP_UV]),
      Buffer.from([0, 0, 0, 1]), // signature counter
    ]);
    const signature = ecdsaSign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      { key: this.privateKey, dsaEncoding: 'ieee-p1363' },
    );
    const r = BigInt(`0x${signature.subarray(0, 32).toString('hex')}`);
    let s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
    if (s > P256_N / 2n) s = P256_N - s; // both are valid ECDSA; the contract accepts only low s
    return {
      r: hex32(r),
      s: hex32(s),
      challengeIndex: BigInt(clientDataJSON.indexOf('"challenge"')),
      typeIndex: BigInt(clientDataJSON.indexOf('"type"')),
      authenticatorData: `0x${authenticatorData.toString('hex')}`,
      clientDataJSON,
    };
  }
}
