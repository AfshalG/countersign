import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Reason } from '@countersign/shared';
import type { PaymentRequestRow } from './db/schema.js';
import { paymentTypedData, type Payment } from './payment.js';

export type CheckInput = {
  request: PaymentRequestRow;
  payment: Payment;
  chainId: number;
  /** A check with no payment (POST /v1/checks): answer, but never sign. */
  dryRun?: boolean;
};

export type CheckResult =
  | { verdict: 'release'; checkerSig: Hex; evidence: unknown }
  | { verdict: 'hold'; reason: Reason; evidence: unknown };

/**
 * The checker, seen from the gateway. The real one is a separate service with its own key
 * (Slice 10); the gateway never holds the checker key. It must answer within the timer's
 * time limit; an error or a timeout is a hold.
 */
export interface Checker {
  /**
   * `startTimer` starts the checker's time limit and returns its signal. A checker calls it when it
   * starts waiting on the checking itself, after anything the gateway reads for it (Slice 16: at
   * volume the gateway's own paced chain reads queue, and must not eat the checker's time).
   */
  check(input: CheckInput, startTimer: () => AbortSignal): Promise<CheckResult>;
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

  async check(input: CheckInput, startTimer: () => AbortSignal): Promise<CheckResult> {
    this.calls++;
    startTimer().throwIfAborted();
    const reason = this.holdIf?.(input);
    if (reason !== undefined)
      return { verdict: 'hold', reason, evidence: { checker: 'test', reason } };
    if (input.dryRun === true)
      return { verdict: 'release', checkerSig: '0x', evidence: { checker: 'test', dryRun: true } };
    const account = privateKeyToAccount(this.key);
    const checkerSig = await account.signTypedData(
      paymentTypedData(this.chainId, input.request.vault as Address, input.payment),
    );
    this.lastSigner = account.address;
    this.lastSignature = checkerSig;
    return { verdict: 'release', checkerSig, evidence: { checker: 'test' } };
  }
}
