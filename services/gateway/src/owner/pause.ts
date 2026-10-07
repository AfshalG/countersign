import { encodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { countersignAccountAbi, GAS_LIMITS } from '@countersign/chain';
import { accountDomain, ownerActionTypes } from '@countersign/shared';
import type { Store } from '../db/store.js';
import { AssertionError, fromBrowser, type BrowserAssertion } from '../api/webauthn.js';
import { OwnerActionError, sendAndWait, type OwnerSendDeps } from './send.js';

/**
 * The stop button (Slice 9 part 3, D23): the owner pauses the account with their passkey, and
 * every vault refuses to pay until they unpause it (a payment meanwhile is held, reason
 * `paused`). Like every owner action it carries the owner nonce and a deadline; the deadline is
 * shown with the challenge and sent back with the assertion, so it cannot expire between the
 * phone reading it and signing it.
 */

export interface PauseChain {
  paused(account: Address): Promise<boolean>;
  ownerNonce(account: Address): Promise<bigint>;
  dryRun(to: Address, data: Hex): Promise<string | undefined>;
  finalizedReceipt(
    hash: Hex,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null>;
}

export type PauseDeps = OwnerSendDeps & {
  store: Pick<Store, 'pendingRelayerTx'>;
  chain: PauseChain;
  chainId: number;
};

export type PauseAction = 'pause' | 'unpause';

/** Ten minutes to sign; a deadline sent back may be at most an hour away. */
const SIGN_WITHIN = 600;
const LONGEST = 3_600;

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

/** Whether the account is paused, and the one action that changes it, ready to sign. */
export async function ownerView(deps: PauseDeps, account: Address, nowMs = Date.now()) {
  const [paused, nonce] = await Promise.all([
    deps.chain.paused(account),
    deps.chain.ownerNonce(account),
  ]);
  const action: PauseAction = paused ? 'unpause' : 'pause';
  const deadline = BigInt(Math.floor(nowMs / 1000) + SIGN_WITHIN);
  return {
    account,
    paused,
    actions: {
      [action]: {
        challenge: challengeOf(deps.chainId, account, action, nonce, deadline),
        deadline: Number(deadline),
        summary: SUMMARY[action],
        typedData: {
          domain: accountDomain(deps.chainId, account),
          primaryType: PRIMARY[action],
          types: { [PRIMARY[action]]: ownerActionTypes[PRIMARY[action]] },
          message: { nonce: nonce.toString(), deadline: deadline.toString() },
        },
      },
    } as Record<string, { challenge: Hex; deadline: number; summary: string; typedData: unknown }>,
  };
}

/** Pauses or unpauses with the owner's passkey: checked, dry-run, sent, final. */
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
  if (!Number.isInteger(deadline) || deadline <= now || deadline > now + LONGEST)
    throw new OwnerActionError(400, 'bad_deadline', 'use the deadline shown with the challenge');
  const nonce = await deps.chain.ownerNonce(account);
  let auth;
  try {
    auth = fromBrowser(
      assertion as BrowserAssertion,
      challengeOf(deps.chainId, account, action, nonce, BigInt(deadline)),
    );
  } catch (e) {
    if (!(e instanceof AssertionError)) throw e;
    throw new OwnerActionError(e.code === 'challenge_mismatch' ? 422 : 400, e.code, e.message);
  }
  const data = encodeFunctionData({
    abi: countersignAccountAbi,
    functionName: action,
    args: [nonce, BigInt(deadline), auth],
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
    GAS_LIMITS[action],
    `owner ${account} ${action} ${String(nonce)}`,
  );
  return ownerView(deps, account);
}
