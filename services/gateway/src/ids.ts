import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from 'viem';

/**
 * A payment request's id: the same account, order vault and invoice always give the same id,
 * so a retry or a second agent submitting the same invoice gets the existing request and its
 * status instead of a second payment (money rule 5). A vault pays each invoice hash once
 * anyway; this stops the duplicate before it costs a transaction fee.
 */
export function requestId(account: Address, vault: Address, invoiceHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [getAddress(account), getAddress(vault), invoiceHash],
    ),
  );
}

/** A run's id: the same set of requests, in any order, is the same run. */
export function runId(account: Address, requestIds: readonly Hex[]): Hex {
  const sorted = [...requestIds].map((id) => id.toLowerCase() as Hex).sort();
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32[]' }],
      [getAddress(account), sorted],
    ),
  );
}
