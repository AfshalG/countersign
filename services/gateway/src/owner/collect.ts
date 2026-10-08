import type { Address, Hex } from 'viem';
import type { OwnerKey, OwnerSig, WebAuthnAuth } from '../chain/types.js';
import type { Store } from '../db/store.js';
import { OwnerActionError } from './send.js';
import { ownerSigned } from './passkey.js';
import { sigsOf, storedSigs } from './signers.js';

/**
 * Gathering several owners' signatures for one action (D36). The contract counts them (D32); the
 * gateway gathers each owner's assertion as it arrives, keeps it under the digest it signed, and
 * hands the contract the signatures in owner order once there are enough. It refuses only what
 * could never count: an assertion over another action, or a passkey that is not an owner's.
 */

/** An account's owners and its two thresholds, read from the account. */
export type Ownership = { owners: OwnerKey[]; manage: number; release: number };

/** Which threshold an action needs: manage, release, or any one owner (pause, refuse). */
export type Threshold = 'manage' | 'release' | 'one';

export type CollectDeps = {
  store: Pick<Store, 'addOwnerSignature' | 'ownerSignatures'>;
  chain: { ownership(account: Address): Promise<Ownership> };
};

export type Collected =
  { ready: true; sigs: OwnerSig[] } | { ready: false; need: number; signed: number[] };

export const needOf = (o: Ownership, t: Threshold) =>
  t === 'manage' ? o.manage : t === 'release' ? o.release : 1;

const same = (a: OwnerKey, b: { qx: string; qy: string }) =>
  a.qx.toLowerCase() === b.qx.toLowerCase() && a.qy.toLowerCase() === b.qy.toLowerCase();

/** The challenge a WebAuthn assertion signed must be this digest, in a `webauthn.get`. */
function signsDigest(auth: WebAuthnAuth, digest: Hex): boolean {
  try {
    const client = JSON.parse(auth.clientDataJSON) as { type?: unknown; challenge?: unknown };
    return (
      client.type === 'webauthn.get' &&
      client.challenge === Buffer.from(digest.slice(2), 'hex').toString('base64url')
    );
  } catch {
    return false;
  }
}

/** The stored assertions for `digest` from the current owners, by owner index, in owner order. */
async function gathered(deps: CollectDeps, o: Ownership, digest: Hex): Promise<OwnerSig[]> {
  const rows = await deps.store.ownerSignatures(digest);
  const byOwner = new Map<number, OwnerSig>();
  for (const row of rows) {
    // An owner removed since they signed no longer counts; one renumbered is found by key.
    const owner = o.owners.findIndex((k) => same(k, row));
    if (owner === -1 || byOwner.has(owner)) continue;
    const [sig] = sigsOf([{ owner, auth: row.auth as Record<string, unknown> }]);
    if (sig) byOwner.set(owner, sig);
  }
  return [...byOwner.values()].sort((a, b) => a.owner - b.owner);
}

/**
 * Adds one owner's assertion for the action whose digest is `digest`, and says whether the
 * action can go out. A one-owner account's assertion goes out at once as owner 0, and the
 * contract checks it, as before D36. With several owners the assertion is matched to its owner
 * off chain, so a stranger's passkey is refused here and never stored.
 */
export async function collect(
  deps: CollectDeps,
  a: {
    account: Address;
    digest: Hex;
    auth: WebAuthnAuth;
    threshold: Threshold;
    purpose: string;
    detail?: unknown;
  },
): Promise<Collected> {
  const o = await deps.chain.ownership(a.account);
  const need = needOf(o, a.threshold);
  if (o.owners.length === 1) return { ready: true, sigs: [{ owner: 0, auth: a.auth }] };
  // Stored for later, so checked here first: the contract would refuse it only when it is sent.
  if (!signsDigest(a.auth, a.digest))
    throw new OwnerActionError(422, 'challenge_mismatch', 'the passkey signed a different action');
  const owner = o.owners.findIndex((k) => ownerSigned(k, a.auth));
  if (owner === -1)
    throw new OwnerActionError(422, 'invalid_passkey', 'not one of this account’s passkeys');
  if (need <= 1) return { ready: true, sigs: [{ owner, auth: a.auth }] };
  const [stored] = storedSigs([{ owner, auth: a.auth }]);
  await deps.store.addOwnerSignature({
    digest: a.digest,
    qx: o.owners[owner]?.qx ?? '0x',
    qy: o.owners[owner]?.qy ?? '0x',
    account: a.account,
    purpose: a.purpose,
    auth: stored?.auth,
    detail: a.detail,
  });
  const sigs = await gathered(deps, o, a.digest);
  if (sigs.length >= need) return { ready: true, sigs: sigs.slice(0, need) };
  return { ready: false, need, signed: sigs.map((s) => s.owner) };
}

/** How many owners an action needs and which have signed it, for the views. */
export async function progress(
  deps: CollectDeps,
  account: Address,
  digest: Hex,
  threshold: Threshold,
): Promise<{ need: number; signed: number[] }> {
  const o = await deps.chain.ownership(account);
  const sigs = await gathered(deps, o, digest);
  return { need: needOf(o, threshold), signed: sigs.map((s) => s.owner) };
}
