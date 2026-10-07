import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Reason } from '@countersign/shared';
import type { PaymentRequestRow } from './db/schema.js';
import { paymentTypedData, type Payment } from './payment.js';

export type CheckInput = { request: PaymentRequestRow; payment: Payment; chainId: number };

export type CheckResult =
  | { verdict: 'release'; checkerSig: Hex; evidence: unknown }
  | { verdict: 'hold'; reason: Reason; evidence: unknown };

/**
 * The checker, seen from the gateway. The real one is a separate service with its own key
 * (Slice 10); the gateway never holds the checker key. It must answer within the signal's
 * time limit; an error or a timeout is a hold.
 */
export interface Checker {
  check(input: CheckInput, signal: AbortSignal): Promise<CheckResult>;
}

/**
 * A stand-in until Slice 10: releases every payment by signing it with a test key, unless
 * `holdIf` returns a reason. Used in tests and on testnet with a testnet-only key.
 */
export class TestChecker implements Checker {
  calls = 0;
  lastSigner: Address | undefined;
  lastSignature: Hex | undefined;

  constructor(
    private readonly key: Hex,
    private readonly chainId: number,
    private readonly holdIf?: (input: CheckInput) => Reason | undefined,
  ) {}

  async check(input: CheckInput, signal: AbortSignal): Promise<CheckResult> {
    this.calls++;
    signal.throwIfAborted();
    const reason = this.holdIf?.(input);
    if (reason !== undefined)
      return { verdict: 'hold', reason, evidence: { checker: 'test', reason } };
    const account = privateKeyToAccount(this.key);
    const checkerSig = await account.signTypedData(
      paymentTypedData(this.chainId, input.request.vault as Address, input.payment),
    );
    this.lastSigner = account.address;
    this.lastSignature = checkerSig;
    return { verdict: 'release', checkerSig, evidence: { checker: 'test' } };
  }
}
