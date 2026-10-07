import type { Address, Hex } from 'viem';
import type { Payment } from '../payment.js';
import type { DecodedRefusal } from './refusals.js';

/** OpenZeppelin's WebAuthn.WebAuthnAuth, as the passkey produces it. */
export type WebAuthnAuth = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

/** How a payment is released: the agent's and checker's signatures, or the owner's passkey. */
export type PaymentCall =
  | { kind: 'pay'; agentSig: Hex; checkerSig: Hex }
  | { kind: 'payWithOwner'; ownerAuth: WebAuthnAuth };

/** What the gateway needs from Monad. The real one is src/chain/monad.ts; tests use a fake. */
export interface Chain {
  /** Runs the vault payment as an eth_call: undefined if it would succeed, otherwise the contract's refusal. */
  simulate(
    vault: Address,
    payment: Payment,
    call: PaymentCall,
  ): Promise<DecodedRefusal | undefined>;
  /** Whether the owner's passkey signed this decision for this vault (an eth_call of recordDecisionByOwner). */
  verifyOwnerDecision(vault: Address, decision: Decision, auth: WebAuthnAuth): Promise<boolean>;
  /** A transaction's receipt once it is in a finalized block; null if it is not (yet). */
  finalizedReceipt(
    hash: Hex,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null>;
}

/** A held, refused or blocked outcome (contracts/src/CountersignTypes.sol). */
export type Decision = { invoiceHash: Hex; outcome: number; reasonHash: Hex; evidenceHash: Hex };
