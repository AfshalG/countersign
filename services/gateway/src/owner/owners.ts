import { encodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { countersignAccountAbi, ownerGas } from '@countersign/chain';
import { accountDomain, ownerActionTypes } from '@countersign/shared';
import type { Store } from '../db/store.js';
import { AssertionError, fromBrowser, type BrowserAssertion } from '../api/webauthn.js';
import type { OwnerKey } from '../chain/types.js';
import { collect, progress, type CollectDeps, type Ownership } from './collect.js';
import { publicKeyOf } from './keys.js';
import { OwnerActionError, sendAndWait, type OwnerSendDeps } from './send.js';

/**
 * Changing an account's owners and thresholds (D36): `setOwners`, signed by the manage threshold
 * of the current owners. The new owner's phone makes a passkey and sends its public key; the
 * change is previewed (its challenge, in plain words), and each current owner signs that same
 * challenge. Like every owner action it carries the owner nonce and a deadline; a change waiting
 * for owners is listed with the account, so the next owner finds it.
 */

export type OwnersDeps = OwnerSendDeps & {
  store: Pick<
    Store,
    'pendingRelayerTx' | 'addOwnerSignature' | 'ownerSignatures' | 'ownerSignaturesFor'
  >;
  chain: CollectDeps['chain'] & {
    ownerNonce(account: Address): Promise<bigint>;
    dryRun(to: Address, data: Hex): Promise<string | undefined>;
    finalizedReceipt(
      hash: Hex,
    ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null>;
  };
  chainId: number;
};

/** The most owners an account can have (the contract's MAX_OWNERS). */
const MAX_OWNERS = 5;
/** A day to gather the owners' signatures; a deadline sent back may be at most 25 hours away. */
const SIGN_WITHIN = 86_400;
const LONGEST = 25 * 3_600;

type PublicKeyInput = { x?: string | undefined; y?: string | undefined; spki?: string | undefined };
export type OwnersChange = { owners: PublicKeyInput[]; manage: number; release: number };
type Detail = {
  owners: OwnerKey[];
  manage: number;
  release: number;
  nonce: string;
  deadline: number;
};

/** Refuses a set the contract would refuse (InvalidOwners), before anyone signs it. */
function validated(change: OwnersChange): { keys: OwnerKey[]; manage: number; release: number } {
  const keys = change.owners.map((o) => publicKeyOf(o));
  const n = keys.length;
  const bad = (message: string) => new OwnerActionError(400, 'bad_owners', message);
  if (n === 0 || n > MAX_OWNERS) throw bad(`an account has one to ${String(MAX_OWNERS)} owners`);
  const seen = new Set(keys.map((k) => `${k.qx}:${k.qy}`.toLowerCase()));
  if (seen.size !== n) throw bad('the same passkey is listed twice');
  for (const [name, t] of [
    ['manage', change.manage],
    ['release', change.release],
  ] as const)
    if (!Number.isInteger(t) || t < 1 || t > n)
      throw bad(`${name} must be between 1 and the number of owners (${String(n)})`);
  return { keys, manage: change.manage, release: change.release };
}

const challengeOf = (
  chainId: number,
  account: Address,
  d: { keys: OwnerKey[]; manage: number; release: number },
  nonce: bigint,
  deadline: bigint,
) =>
  hashTypedData({
    domain: accountDomain(chainId, account),
    types: ownerActionTypes,
    primaryType: 'SetOwners',
    message: { owners: d.keys, manage: d.manage, release: d.release, nonce, deadline },
  });

/** What the change does, in plain words. */
export function ownersSummary(owners: number, manage: number, release: number): string {
  const of = (n: number) => (n === 1 ? 'one passkey' : `${String(n)} of their passkeys`);
  return (
    `${String(owners)} ${owners === 1 ? 'owner' : 'owners'}. Adding or changing a supplier, ` +
    `opening an order, changing the rules or the owners, and unpausing need ${of(manage)}; ` +
    `paying a held payment once needs ${of(release)}. Any one owner can pause the account or ` +
    'refuse a payment.'
  );
}

/** The change, ready to sign: its challenge, its typed data, and what it needs. */
async function actionOf(
  deps: OwnersDeps,
  account: Address,
  d: { keys: OwnerKey[]; manage: number; release: number },
  nonce: bigint,
  deadline: number,
  ownership: Ownership,
) {
  const challenge = challengeOf(deps.chainId, account, d, nonce, BigInt(deadline));
  return {
    challenge,
    deadline,
    owners: d.keys,
    manage: d.manage,
    release: d.release,
    summary: ownersSummary(d.keys.length, d.manage, d.release),
    typedData: {
      domain: accountDomain(deps.chainId, account),
      primaryType: 'SetOwners',
      types: { SetOwners: ownerActionTypes.SetOwners, OwnerKey: ownerActionTypes.OwnerKey },
      message: {
        owners: d.keys,
        manage: d.manage,
        release: d.release,
        nonce: nonce.toString(),
        deadline: String(deadline),
      },
    },
    signatures: await progress(
      { ...deps, chain: { ownership: () => Promise.resolve(ownership) } },
      account,
      challenge,
      'manage',
    ),
  };
}

/** Previews an owner change: nothing is stored until an owner signs it. */
export async function previewOwners(
  deps: OwnersDeps,
  account: Address,
  change: OwnersChange,
  nowMs = Date.now(),
) {
  const d = validated(change);
  const [nonce, ownership] = await Promise.all([
    deps.chain.ownerNonce(account),
    deps.chain.ownership(account),
  ]);
  return actionOf(deps, account, d, nonce, Math.floor(nowMs / 1000) + SIGN_WITHIN, ownership);
}

/** Owner changes some owners have signed at the account's current nonce, still in time. */
export async function pendingOwnerChanges(
  deps: OwnersDeps,
  account: Address,
  nonce: bigint,
  ownership: Ownership,
  nowMs = Date.now(),
) {
  const now = Math.floor(nowMs / 1000);
  const rows = await deps.store.ownerSignaturesFor(account, 'set_owners');
  const open = new Map<string, Detail>();
  for (const row of rows) {
    const d = row.detail as Detail | null;
    if (d?.nonce === nonce.toString() && d.deadline > now + 60) open.set(row.digest, d);
  }
  return Promise.all(
    [...open.values()].map((d) =>
      actionOf(
        deps,
        account,
        { keys: d.owners, manage: d.manage, release: d.release },
        nonce,
        d.deadline,
        ownership,
      ),
    ),
  );
}

/**
 * Signs an owner change with one owner's passkey: checked, gathered until the manage threshold has
 * signed, dry-run, sent, final. `waiting` while more owners must sign.
 */
export async function changeOwners(
  deps: OwnersDeps,
  account: Address,
  change: OwnersChange & { deadline: number },
  assertion: unknown,
): Promise<{ waiting: boolean }> {
  const d = validated(change);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(change.deadline) ||
    change.deadline <= now ||
    change.deadline > now + LONGEST
  )
    throw new OwnerActionError(400, 'bad_deadline', 'use the deadline shown with the challenge');
  const nonce = await deps.chain.ownerNonce(account);
  const challenge = challengeOf(deps.chainId, account, d, nonce, BigInt(change.deadline));
  let auth;
  try {
    auth = fromBrowser(assertion as BrowserAssertion, challenge);
  } catch (e) {
    if (!(e instanceof AssertionError)) throw e;
    throw new OwnerActionError(e.code === 'challenge_mismatch' ? 422 : 400, e.code, e.message);
  }
  const got = await collect(deps, {
    account,
    digest: challenge,
    auth,
    threshold: 'manage',
    purpose: 'set_owners',
    detail: {
      owners: d.keys,
      manage: d.manage,
      release: d.release,
      nonce: nonce.toString(),
      deadline: change.deadline,
    } satisfies Detail,
  });
  if (!got.ready) return { waiting: true };
  const data = encodeFunctionData({
    abi: countersignAccountAbi,
    functionName: 'setOwners',
    args: [d.keys, d.manage, d.release, nonce, BigInt(change.deadline), got.sigs],
  });
  const refusal = await deps.chain.dryRun(account, data);
  if (refusal === 'InvalidOwnerSignature')
    throw new OwnerActionError(422, 'invalid_passkey', 'not one of this account’s passkeys');
  if (refusal === 'BadNonce')
    throw new OwnerActionError(
      409,
      'stale',
      'the account changed since this was shown; open it again',
    );
  if (refusal !== undefined)
    throw new OwnerActionError(409, 'contract_refuses', `setOwners refused: ${refusal}`, {
      contract: refusal,
    });
  await sendAndWait(
    deps,
    account,
    data,
    ownerGas('setOwners', got.sigs.length, d.keys.length),
    `owner ${account} setOwners ${String(nonce)}`,
  );
  return { waiting: false };
}
