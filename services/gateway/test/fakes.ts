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

  simulate(
    _vault: Address,
    payment: Payment,
    call: PaymentCall,
  ): Promise<DecodedRefusal | undefined> {
    this.simulations++;
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
