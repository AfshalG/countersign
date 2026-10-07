import { encodeFunctionData, type Address, type Hex } from 'viem';
import { GAS_LIMITS, orderVaultAbi } from '@countersign/chain';
import type { Chain, PaymentCall, WebAuthnAuth } from '../chain/types.js';
import type { PaymentRequestRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { paymentOf } from '../payment.js';
import type { RelayerPool } from '../relay/pool.js';
import { SimulationUnavailable } from './check.js';

export type SendDeps = { store: Store; chain: Pick<Chain, 'simulate'>; pool: RelayerPool };

/** The owner's passkey assertion as stored (JSON: bigints as strings). */
function ownerAuthOf(stored: unknown): WebAuthnAuth {
  const a = stored as Record<string, string>;
  const field = (k: string) => {
    const v = a[k];
    if (typeof v !== 'string') throw new Error(`owner assertion is missing ${k}`);
    return v;
  };
  return {
    r: field('r') as Hex,
    s: field('s') as Hex,
    challengeIndex: BigInt(field('challengeIndex')),
    typeIndex: BigInt(field('typeIndex')),
    authenticatorData: field('authenticatorData') as Hex,
    clientDataJSON: field('clientDataJSON'),
  };
}

function callOf(row: PaymentRequestRow): PaymentCall {
  if (row.ownerAuth !== null)
    return { kind: 'payWithOwner', ownerAuth: ownerAuthOf(row.ownerAuth) };
  if (row.checkerSig === null)
    throw new Error(`request ${row.id} is released without a checker signature or a passkey`);
  return { kind: 'pay', agentSig: row.agentSig as Hex, checkerSig: row.checkerSig as Hex };
}

/**
 * Sends one released payment.
 *
 * A transaction already signed for it (the gateway stopped between signing and sending) is sent
 * again as it is: same nonce, same hash, so it can never be paid twice. Otherwise the payment is
 * simulated once more (the order may have closed since the check: then it fails with the
 * contract's reason and no nonce is used), signed with a relayer's next nonce and stored on the
 * request in one database transaction, moved to `settling`, and handed to the relayer's lane.
 */
export async function sendOne(deps: SendDeps, row: PaymentRequestRow): Promise<void> {
  const { store, chain, pool } = deps;
  if (row.status !== 'released') return;

  if (
    row.rawTx !== null &&
    row.txHash !== null &&
    row.relayer !== null &&
    row.relayerNonce !== null
  ) {
    await store.transition(row.id, 'released', 'settling', { sentAt: new Date() });
    pool.adopt({
      relayer: row.relayer as Address,
      nonce: row.relayerNonce,
      raw: row.rawTx as Hex,
      hash: row.txHash as Hex,
    });
    return;
  }

  const vault = row.vault as Address;
  const payment = paymentOf(row);
  const call = callOf(row);
  let refusal;
  try {
    refusal = await chain.simulate(vault, payment, call);
  } catch (e) {
    throw new SimulationUnavailable(e); // stays released; its lease expires and it is tried again
  }
  if (refusal !== undefined) {
    await store.transition(row.id, 'released', 'failed', {
      reason: refusal.reason,
      decidedBy: 'rule',
      detail: { contract: refusal.error },
    });
    return;
  }

  const data =
    call.kind === 'pay'
      ? encodeFunctionData({
          abi: orderVaultAbi,
          functionName: 'pay',
          args: [payment, call.agentSig, call.checkerSig],
        })
      : encodeFunctionData({
          abi: orderVaultAbi,
          functionName: 'payWithOwner',
          args: [payment, call.ownerAuth],
        });
  const gas = call.kind === 'pay' ? GAS_LIMITS.pay : GAS_LIMITS.payWithOwner;
  const signed = await pool.sign({ to: vault, data, gas }, row.id);
  await store.transition(row.id, 'released', 'settling', { sentAt: new Date() });
  pool.enqueue(signed);
}
