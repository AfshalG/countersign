import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { paymentTypes, vaultDomain } from '@countersign/shared';
import type { PaymentFacts } from './types.js';

/** Signs a release: the vault's EIP-712 `Payment`, in that vault's domain (Slice 5, D22). */
export type Signer = { address: Address; sign(payment: PaymentFacts): Promise<Hex> };

/** The checker key, held only by this service (the gateway never holds it). */
export function keySigner(privateKey: Hex): Signer {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    sign: (p) =>
      account.signTypedData({
        domain: vaultDomain(p.chainId, p.vault),
        types: paymentTypes,
        primaryType: 'Payment',
        message: {
          amount: p.amount,
          invoiceHash: p.invoiceHash,
          payTo: p.payTo,
          deadline: p.deadline,
        },
      }),
  };
}
