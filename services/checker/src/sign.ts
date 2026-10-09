import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decisionTypes, paymentTypes, vaultDomain } from '@countersign/shared';
import type { PaymentFacts } from './types.js';

/** A hold as the vault records it (`recordDecision`, Slice 18): events only, it moves no money. */
export type Decision = { invoiceHash: Hex; outcome: number; reasonHash: Hex; evidenceHash: Hex };
export type SignedDecision = Decision & { sig: Hex };

/**
 * Signs a release, the vault's EIP-712 `Payment`, and a hold, its `Decision`, each in that vault's
 * domain (Slice 5, D22). Different types: a signed hold can never be used to pay.
 */
export type Signer = {
  address: Address;
  sign(payment: PaymentFacts): Promise<Hex>;
  signDecision(chainId: number, vault: Address, decision: Decision): Promise<Hex>;
};

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
    signDecision: (chainId, vault, d) =>
      account.signTypedData({
        domain: vaultDomain(chainId, vault),
        types: decisionTypes,
        primaryType: 'Decision',
        message: d,
      }),
  };
}
