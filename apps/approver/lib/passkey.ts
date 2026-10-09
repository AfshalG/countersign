'use client';
import { b64url, fromB64url, hexToBytes } from './encoding';

/**
 * The phone's passkey (Slice 11, S11-2): the browser's own WebAuthn. P-256 (alg -7) with user
 * verification required, as the account's contract demands; discoverable, so it can sign without
 * this phone remembering anything. The gateway reads the raw assertion (base64url fields, a DER
 * signature) and the vault verifies it, so nothing here does cryptography.
 */

export type Assertion = { authenticatorData: string; clientDataJSON: string; signature: string };

export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

/** A new passkey on this device. Returns its id and its public key (SPKI, base64url). */
export async function createPasskey(
  label: string,
): Promise<{ credentialId: string; spki: string }> {
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Countersign' },
      user: { id: userId, name: label, displayName: label },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'required',
        requireResidentKey: true,
      },
      attestation: 'none',
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was made.');
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey();
  if (!spki) throw new Error('This device did not give the passkey’s public key.');
  return { credentialId: b64url(credential.rawId), spki: b64url(spki) };
}

/** Signs a challenge (an EIP-712 digest) with Face ID, Touch ID or the device's PIN. */
export async function signChallenge(
  challenge: string,
  credentialId?: string | null,
): Promise<Assertion> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(challenge),
      userVerification: 'required',
      timeout: 120_000,
      ...(credentialId
        ? { allowCredentials: [{ type: 'public-key' as const, id: fromB64url(credentialId) }] }
        : {}),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Nothing was signed.');
  const r = credential.response as AuthenticatorAssertionResponse;
  return {
    authenticatorData: b64url(r.authenticatorData),
    clientDataJSON: b64url(r.clientDataJSON),
    signature: b64url(r.signature),
  };
}

/** A passkey prompt the person closed, in plain words; anything else as it came. */
export function passkeyProblem(e: unknown): string {
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError'))
    return 'The passkey prompt was closed. Nothing was signed.';
  return e instanceof Error ? e.message : String(e);
}
