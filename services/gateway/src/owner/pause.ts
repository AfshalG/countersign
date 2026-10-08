import { encodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { countersignAccountAbi, ownerGas } from '@countersign/chain';
import { accountDomain, ownerActionTypes } from '@countersign/shared';
import type { Store } from '../db/store.js';
import { AssertionError, fromBrowser, type BrowserAssertion } from '../api/webauthn.js';
import { OwnerActionError, sendAndWait, type OwnerSendDeps } from './send.js';
import { collect, progress } from './collect.js';
import { pendingOwnerChanges } from './owners.js';

/**
 * The stop button (Slice 9 part 3, D23): the owner pauses the account with their passkey, and
 * every vault refuses to pay until they unpause it (a payment meanwhile is held, reason
 * `paused`). Like every owner action it carries the owner nonce and a deadline; the deadline is
 * shown with the challenge and sent back with the assertion, so it cannot expire between the
 * phone reading it and signing it.
 */

export interface PauseChain {
  ownership(
    account: Address,
  ): Promise<{ owners: { qx: Hex; qy: Hex }[]; manage: number; release: number }>;
  paused(account: Address): Promise<boolean>;
  ownerNonce(account: Address): Promise<bigint>;
  dryRun(to: Address, data: Hex): Promise<string | undefined>;
  finalizedReceipt(
    hash: Hex,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null>;
}

export type PauseDeps = OwnerSendDeps & {
  store: Pick<
    Store,
    'pendingRelayerTx' | 'addOwnerSignature' | 'ownerSignatures' | 'ownerSignaturesFor'
  >;
  chain: PauseChain;
  chainId: number;
};

export type PauseAction = 'pause' | 'unpause';

/**
 * Ten minutes to sign. An unpause that needs several owners (D36) gets a day, so the others can
 * sign the same challenge later. A deadline sent back may be at most an hour away for a pause
 * (one owner, at once) and 25 hours for an unpause.
 */
const SIGN_WITHIN = 600;
const SIGN_WITHIN_SEVERAL = 86_400;
const LONGEST = { pause: 3_600, unpause: 25 * 3_600 } as const;

const PRIMARY = { pause: 'Pause', unpause: 'Unpause' } as const;
const SUMMARY = {
  pause: 'Stop every payment from this account until you unpause it',
  unpause: 'Let payments from this account go out again',
} as const;

function challengeOf(
  chainId: number,
  account: Address,
  action: PauseAction,
  nonce: bigint,
  deadline: bigint,
) {
  return hashTypedData({
    domain: accountDomain(chainId, account),
    types: ownerActionTypes,
    primaryType: PRIMARY[action],
    message: { nonce, deadline },
  });
}

type UnpauseDetail = { nonce: string; deadline: number };

/**
 * The deadline of an unpause some owners have already signed at this nonce, if it has time left:
 * the others must sign the same challenge (D36).
 */
async function pendingUnpause(
  deps: PauseDeps,
  account: Address,
  nonce: bigint,
  nowSeconds: number,
): Promise<number | undefined> {
  const rows = await deps.store.ownerSignaturesFor(account, 'unpause');
  const open = rows
    .map((r) => r.detail as UnpauseDetail | null)
    .filter(
      (d): d is UnpauseDetail => d?.nonce === nonce.toString() && d.deadline > nowSeconds + 60,
    );
  return open.at(-1)?.deadline;
}

/**
 * Whether the account is paused, and the one action that changes it, ready to sign, with how many
 * owners it needs; and the account's owners and thresholds (D36).
 */
export async function ownerView(deps: PauseDeps, account: Address, nowMs = Date.now()) {
  const [paused, nonce, ownership] = await Promise.all([
    deps.chain.paused(account),
    deps.chain.ownerNonce(account),
    deps.chain.ownership(account),
  ]);
  const action: PauseAction = paused ? 'unpause' : 'pause';
  const now = Math.floor(nowMs / 1000);
  const several = action === 'unpause' && ownership.manage > 1;
  const deadline = BigInt(
    (several ? await pendingUnpause(deps, account, nonce, now) : undefined) ??
      now + (several ? SIGN_WITHIN_SEVERAL : SIGN_WITHIN),
  );
  const challenge = challengeOf(deps.chainId, account, action, nonce, deadline);
  return {
    account,
    paused,
    owners: ownership.owners.map((k, owner) => ({ owner, qx: k.qx, qy: k.qy })),
    manage: ownership.manage,
    release: ownership.release,
    /** D36: owner changes some owners have signed and others still can. */
    ownerChanges: await pendingOwnerChanges(deps, account, nonce, ownership, nowMs),
    actions: {
      [action]: {
        challenge,
        deadline: Number(deadline),
        summary: SUMMARY[action],
        typedData: {
          domain: accountDomain(deps.chainId, account),
          primaryType: PRIMARY[action],
          types: { [PRIMARY[action]]: ownerActionTypes[PRIMARY[action]] },
          message: { nonce: nonce.toString(), deadline: deadline.toString() },
        },
        signatures: await progress(deps, account, challenge, action === 'pause' ? 'one' : 'manage'),
      },
    } as Record<
      string,
      {
        challenge: Hex;
        deadline: number;
        summary: string;
        typedData: unknown;
        signatures: { need: number; signed: number[] };
      }
    >,
  };
}

/**
 * Pauses (any one owner) or unpauses (the manage threshold, D36) with an owner's passkey: checked,
 * gathered until enough owners have signed, dry-run, sent, final. An unpause still waiting for
 * owners comes back still paused, with what it needs.
 */
export async function setPaused(
  deps: PauseDeps,
  account: Address,
  action: PauseAction,
  deadline: number,
  assertion: unknown,
) {
  const paused = await deps.chain.paused(account);
  if (action === 'pause' && paused)
    throw new OwnerActionError(409, 'already_paused', 'the account is already paused');
  if (action === 'unpause' && !paused)
    throw new OwnerActionError(409, 'not_paused', 'the account is not paused');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(deadline) || deadline <= now || deadline > now + LONGEST[action])
    throw new OwnerActionError(400, 'bad_deadline', 'use the deadline shown with the challenge');
  const nonce = await deps.chain.ownerNonce(account);
  const challenge = challengeOf(deps.chainId, account, action, nonce, BigInt(deadline));
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
    threshold: action === 'pause' ? 'one' : 'manage',
    purpose: action,
    detail: { nonce: nonce.toString(), deadline } satisfies UnpauseDetail,
  });
  if (!got.ready) return ownerView(deps, account);
  const data = encodeFunctionData({
    abi: countersignAccountAbi,
    functionName: action,
    args: [nonce, BigInt(deadline), got.sigs],
  });
  const refusal = await deps.chain.dryRun(account, data);
  if (refusal === 'InvalidOwnerSignature')
    throw new OwnerActionError(422, 'invalid_passkey', 'not this account’s passkey');
  if (refusal === 'BadNonce')
    throw new OwnerActionError(
      409,
      'stale',
      'the account changed since this was shown; open it again',
    );
  if (refusal !== undefined)
    throw new OwnerActionError(409, 'contract_refuses', `${action} refused: ${refusal}`, {
      contract: refusal,
    });
  await sendAndWait(
    deps,
    account,
    data,
    ownerGas(action, got.sigs.length),
    `owner ${account} ${action} ${String(nonce)}`,
  );
  return ownerView(deps, account);
}
