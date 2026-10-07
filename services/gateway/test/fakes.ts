import { encodeErrorResult, type Address, type Hex } from 'viem';
import { orderVaultAbi } from '@countersign/chain';
import type { Chain, PaymentCall } from '../src/chain/types.js';
import type { Payment } from '../src/payment.js';
import { decodeRefusal, type DecodedRefusal } from '../src/chain/refusals.js';

/**
 * A stand-in for the vault on chain: by default every contract rule passes, the agent's
 * signature is valid, and a payment without a checker signature is refused exactly as the
 * contract refuses it (InvalidCheckerSignature). `rule` makes it refuse with any named error.
 */
export class FakeChain implements Chain {
  rule: ((payment: Payment, call: PaymentCall) => string | undefined) | undefined;
  simulations = 0;
  /** False: the owner's passkey signatures are not the account owner's. */
  ownerKeyValid = true;

  verifyOwnerDecision(): Promise<boolean> {
    return Promise.resolve(this.ownerKeyValid);
  }

  finalizedReceipt(): Promise<null> {
    return Promise.resolve(null);
  }

  simulate(
    _vault: Address,
    payment: Payment,
    call: PaymentCall,
  ): Promise<DecodedRefusal | undefined> {
    this.simulations++;
    if (call.kind === 'payWithOwner' && !this.ownerKeyValid) {
      return Promise.resolve(
        decodeRefusal(
          encodeErrorResult({ abi: orderVaultAbi, errorName: 'InvalidOwnerSignature' }),
        ),
      );
    }
    const error =
      this.rule?.(payment, call) ??
      (call.kind === 'pay' && call.checkerSig === '0x' ? 'InvalidCheckerSignature' : undefined);
    if (error === undefined) return Promise.resolve(undefined);
    return Promise.resolve(
      decodeRefusal(
        encodeErrorResult({ abi: orderVaultAbi, errorName: error as 'PayToNotOnFile' }),
      ),
    );
  }
}

export const ACCOUNT: Address = '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603';
export const VAULT: Address = '0xbd19BbE40044a3175A3213D8408a434b882CADF4';
export const SUPPLIER: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
export const AGENT_SIG: Hex = `0x${'ab'.repeat(65)}`;

import type { Sender, SendOutcome } from '../src/relay/pool.js';

/** Records every send. Endpoints listed in `blackHoles` accept a transaction and never include it. */
export class FakeSender implements Sender {
  sent: { endpoint: number; raw: Hex; at: number }[] = [];
  blackHoles = new Set<number>();
  chainNonces = new Map<string, number>();
  /** MON in wei per wallet (lower-case address); 10 MON when not set. */
  balances = new Map<string, bigint>();
  reply: (endpoint: number, raw: Hex) => SendOutcome = () => 'accepted';

  send(endpoint: number, raw: Hex): Promise<SendOutcome> {
    this.sent.push({ endpoint, raw, at: Date.now() });
    return Promise.resolve(this.reply(endpoint, raw));
  }

  nonceOf(address: Address): Promise<number> {
    return Promise.resolve(this.chainNonces.get(address.toLowerCase()) ?? 0);
  }

  balanceOf(address: Address): Promise<bigint> {
    return Promise.resolve(this.balances.get(address.toLowerCase()) ?? 10n ** 19n);
  }

  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    return Promise.resolve({
      maxFeePerGas: 127_500_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
  }
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
