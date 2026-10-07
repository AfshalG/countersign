import type { Address, Hex } from 'viem';
import { paymentTypes, vaultDomain } from '@countersign/shared';
import type { PaymentRequestRow } from './db/schema.js';

/** The EIP-712 `Payment` a vault pays (contracts/src/CountersignTypes.sol). */
export type Payment = { amount: bigint; invoiceHash: Hex; payTo: Address; deadline: bigint };

export function paymentOf(row: PaymentRequestRow): Payment {
  return {
    amount: BigInt(row.amount),
    invoiceHash: row.invoiceHash as Hex,
    payTo: row.payTo as Address,
    deadline: BigInt(row.deadline),
  };
}

/** The typed data the agent, the checker or the owner signs for this payment, in the vault's domain (D22). */
export function paymentTypedData(chainId: number, vault: Address, payment: Payment) {
  return {
    domain: vaultDomain(chainId, vault),
    types: paymentTypes,
    primaryType: 'Payment',
    message: payment,
  } as const;
}
