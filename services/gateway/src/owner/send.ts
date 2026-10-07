import type { Address, Hex } from 'viem';
import type { Store } from '../db/store.js';
import type { RelayerPool } from '../relay/pool.js';
import type { FinalityTracker } from '../chain/finality.js';

/**
 * Sending an owner's passkey-signed actions (judge-mode setup, approving a proposal): through a
 * relayer, stored with its nonce (Slice 6's crash safety), and waited on until Finalized.
 */
export type OwnerSendDeps = {
  store: Pick<Store, 'pendingRelayerTx'>;
  pool: Pick<RelayerPool, 'sign' | 'enqueue'>;
  finality: Pick<FinalityTracker, 'waitFinal'>;
  chain: {
    /** A transaction's receipt once it is in a finalized block; null if it is not (yet). */
    finalizedReceipt(
      hash: Hex,
    ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null>;
  };
  finalTimeoutMs?: number;
};

/** A refusal the routes turn into an HTTP answer (status, code, plain message). */
export class OwnerActionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 429,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Waits until the transaction is final. The wait is registered before the transaction is sent
 * where possible; if it times out (or the block was processed before anyone waited), the chain is
 * asked directly, so a transaction that did land is never reported as lost.
 */
export async function finalOf(
  deps: OwnerSendDeps,
  hash: Hex,
  waiting: Promise<{ status: 'success' | 'reverted'; blockNumber: number }>,
  what: string,
) {
  let receipt;
  try {
    receipt = await waiting;
  } catch (e) {
    receipt = await deps.chain.finalizedReceipt(hash);
    if (!receipt) throw e;
  }
  if (receipt.status !== 'success')
    throw new OwnerActionError(409, 'reverted', `${what} reverted on chain`, { tx: hash });
  return hash;
}

/**
 * Sends one setup transaction through a relayer, stored with its nonce under `purpose` (Slice 6's
 * crash safety: a restart re-sends it unchanged). If a transaction for this purpose is already on
 * its way (sent before a restart), this waits on it instead of sending a second one.
 */
export async function sendAndWait(
  deps: OwnerSendDeps,
  to: Address,
  data: Hex,
  gas: bigint,
  purpose: string,
) {
  const timeout = deps.finalTimeoutMs ?? 60_000;
  const pending = await deps.store.pendingRelayerTx(purpose);
  if (pending) {
    const hash = pending.hash as Hex;
    return finalOf(deps, hash, deps.finality.waitFinal(hash, timeout), purpose);
  }
  const signed = await deps.pool.sign({ to, data, gas }, { purpose });
  const waiting = deps.finality.waitFinal(signed.hash, timeout);
  deps.pool.enqueue(signed);
  return finalOf(deps, signed.hash, waiting, purpose);
}
