import { describe, expect, it } from 'vitest';
import { encodeErrorResult } from 'viem';
import { orderVaultAbi } from '@countersign/chain';
import { decodeRefusal } from '../../src/chain/refusals.js';

describe('decodeRefusal', () => {
  it('turns a contract revert into the typed reason the gateway records', () => {
    const data = encodeErrorResult({ abi: orderVaultAbi, errorName: 'PayToNotOnFile' });
    expect(decodeRefusal(data)).toEqual({
      error: 'PayToNotOnFile',
      status: 'held',
      reason: 'address_mismatch',
    });
  });

  it('blocks a payment over what is left', () => {
    const data = encodeErrorResult({ abi: orderVaultAbi, errorName: 'OverRemaining' });
    expect(decodeRefusal(data)).toEqual({
      error: 'OverRemaining',
      status: 'blocked',
      reason: 'over_limit',
    });
  });

  it('holds on revert data it cannot read (fail closed)', () => {
    expect(decodeRefusal('0xdeadbeef')).toEqual({
      error: 'unknown',
      status: 'held',
      reason: 'checker_unavailable',
    });
    expect(decodeRefusal(undefined)).toEqual({
      error: 'unknown',
      status: 'held',
      reason: 'checker_unavailable',
    });
  });
});
