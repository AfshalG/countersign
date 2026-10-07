import type { Hex } from 'viem';
import type { WebAuthnAuth } from '../chain/types.js';

/** The P-256 group order; OpenZeppelin's P256.verify refuses s above half of it. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export class AssertionError extends Error {
  constructor(
    readonly code: 'malformed_assertion' | 'challenge_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * A passkey assertion as a browser hands it over: `ox`'s shape (hex authenticator data, the client
 * data JSON as a string, `{ r, s }`) or `navigator.credentials.get`'s raw one (base64url fields and
 * a DER signature). Both are accepted, so the approver app sends what it has.
 */
export type BrowserAssertion = {
  authenticatorData: string;
  clientDataJSON: string;
  signature: { r: string; s: string } | string;
};

const HEX = /^0x([0-9a-fA-F]{2})*$/;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function bytesOf(value: string, what: string): Buffer {
  if (HEX.test(value)) return Buffer.from(value.slice(2), 'hex');
  if (B64URL.test(value)) return Buffer.from(value, 'base64url');
  throw new AssertionError('malformed_assertion', `the ${what} is neither hex nor base64url`);
}

const hex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** r and s from a DER ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }. */
function fromDer(bytes: Buffer): { r: bigint; s: bigint } {
  const fail = () =>
    new AssertionError('malformed_assertion', 'the signature is not a DER ECDSA signature');
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) throw fail();
  let at = 2;
  const integer = () => {
    if (bytes[at] !== 0x02) throw fail();
    const length = bytes[at + 1] ?? 0;
    const start = at + 2;
    if (length === 0 || start + length > bytes.length) throw fail();
    at = start + length;
    return BigInt(`0x${bytes.subarray(start, start + length).toString('hex')}`);
  };
  const r = integer();
  const s = integer();
  if (at !== bytes.length) throw fail();
  return { r, s };
}

/**
 * Turns a browser's assertion into what the vault verifies (OpenZeppelin's `WebAuthnAuth`), and
 * checks before anything reaches the chain that it is a `webauthn.get` over `expectedChallenge`
 * (the EIP-712 digest of the action). The indexes are found in the client data JSON, and a high-s
 * signature becomes its low-s twin, which is equally valid and the only form the contract takes.
 * User verification is not checked here: the contract requires it.
 */
export function fromBrowser(assertion: BrowserAssertion, expectedChallenge: Hex): WebAuthnAuth {
  const authenticatorData = bytesOf(assertion.authenticatorData, 'authenticator data');
  if (authenticatorData.length < 37)
    throw new AssertionError('malformed_assertion', 'the authenticator data is too short');

  const clientDataJSON = assertion.clientDataJSON.trimStart().startsWith('{')
    ? assertion.clientDataJSON
    : bytesOf(assertion.clientDataJSON, 'client data').toString('utf8');
  let client: { type?: unknown; challenge?: unknown };
  try {
    client = JSON.parse(clientDataJSON) as { type?: unknown; challenge?: unknown };
  } catch {
    throw new AssertionError('malformed_assertion', 'the client data is not JSON');
  }
  if (client.type !== 'webauthn.get')
    throw new AssertionError('malformed_assertion', 'the ceremony must be webauthn.get');
  if (client.challenge !== Buffer.from(expectedChallenge.slice(2), 'hex').toString('base64url'))
    throw new AssertionError('challenge_mismatch', 'the passkey signed a different action');

  let r: bigint;
  let s: bigint;
  if (typeof assertion.signature === 'string') {
    ({ r, s } = fromDer(bytesOf(assertion.signature, 'signature')));
  } else {
    const parts = assertion.signature;
    if (!HEX.test(parts.r) || !HEX.test(parts.s))
      throw new AssertionError('malformed_assertion', 'the signature r and s must be hex');
    r = BigInt(parts.r);
    s = BigInt(parts.s);
  }
  if (r <= 0n || r >= N || s <= 0n || s >= N)
    throw new AssertionError('malformed_assertion', 'the signature is out of range');
  if (s > N / 2n) s = N - s;

  return {
    r: hex32(r),
    s: hex32(s),
    challengeIndex: BigInt(clientDataJSON.indexOf('"challenge"')),
    typeIndex: BigInt(clientDataJSON.indexOf('"type"')),
    authenticatorData: `0x${authenticatorData.toString('hex')}`,
    clientDataJSON,
  };
}
