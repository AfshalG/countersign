import type { Address } from 'viem';
import type { OwnerKey, OwnerSig, WebAuthnAuth } from '../chain/types.js';
import { ownerSigned } from './passkey.js';

/**
 * Which of an account's owners made a passkey assertion (D36). A single-owner account's only
 * owner is owner 0, and the contract verifies the signature itself as before. With several
 * owners the assertion is checked off chain against each key, so the right index is sent and a
 * stranger's passkey is refused before anything reaches the chain.
 */
export function ownerIndexOf(
  owners: OwnerKey[],
  auth: WebAuthnAuth,
  alwaysCheck = false,
): number | null {
  if (owners.length === 1 && !alwaysCheck) return 0;
  const i = owners.findIndex((k) => ownerSigned(k, auth));
  return i === -1 ? null : i;
}

export async function ownerSigOf(
  chain: { owners(account: Address): Promise<OwnerKey[]> },
  account: Address,
  auth: WebAuthnAuth,
  alwaysCheck = false,
): Promise<OwnerSig | null> {
  const owner = ownerIndexOf(await chain.owners(account), auth, alwaysCheck);
  return owner === null ? null : { owner, auth };
}

/** Owner signatures as stored (JSON: bigints as strings). */
export const storedSigs = (sigs: OwnerSig[]) =>
  sigs.map((s) => ({
    owner: s.owner,
    auth: {
      ...s.auth,
      challengeIndex: s.auth.challengeIndex.toString(),
      typeIndex: s.auth.typeIndex.toString(),
    },
  }));

/** Reads stored owner signatures; a single assertion stored before D36 is owner 0's. */
export function sigsOf(stored: unknown): OwnerSig[] {
  const authOf = (a: Record<string, unknown>): WebAuthnAuth => {
    const field = (k: string) => {
      const v = a[k];
      if (typeof v !== 'string') throw new Error(`owner assertion is missing ${k}`);
      return v;
    };
    return {
      r: field('r') as `0x${string}`,
      s: field('s') as `0x${string}`,
      challengeIndex: BigInt(field('challengeIndex')),
      typeIndex: BigInt(field('typeIndex')),
      authenticatorData: field('authenticatorData') as `0x${string}`,
      clientDataJSON: field('clientDataJSON'),
    };
  };
  if (Array.isArray(stored))
    return stored.map((x: { owner: number; auth: Record<string, unknown> }) => ({
      owner: x.owner,
      auth: authOf(x.auth),
    }));
  return [{ owner: 0, auth: authOf(stored as Record<string, unknown>) }];
}
