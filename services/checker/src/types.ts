import type { Address, Hex } from 'viem';
import type { Reason } from '@countersign/shared';

/** The payment to check: the vault's EIP-712 `Payment`, in that vault's domain. */
export type PaymentFacts = {
  chainId: number;
  vault: Address;
  /** USDC base units. */
  amount: bigint;
  invoiceHash: Hex;
  payTo: Address;
  deadline: bigint;
};

/** What the owner approved: the order's supplier, its address on file, and the quote, if known. */
export type OrderFacts = {
  supplierId: Hex;
  supplierName: string | null;
  addressOnFile: Address;
  quote: { html?: string; text?: string } | null;
};

/** One check and its result, kept as evidence. */
export type Finding = { check: string; ok: boolean; detail: string; reason?: Reason };
