import { describe, expect, it } from 'vitest';
import { walletNeed } from '../../src/relay/funding.js';

const gwei = 1_000_000_000n;

describe('walletNeed', () => {
  it('covers every transaction at the charged price, plus the fee headroom for those in flight', () => {
    // 50 transactions; at most 20 in flight; charged 102 gwei; bid up to 127.5 gwei
    const need = walletNeed({
      count: 50,
      gasLimit: 100_000n,
      chargedPrice: 102n * gwei,
      maxFee: (1275n * gwei) / 10n,
      inFlight: 20,
      float: 0n,
    });
    expect(need).toBe(
      50n * 100_000n * 102n * gwei + 20n * 100_000n * ((1275n * gwei) / 10n - 102n * gwei),
    );
  });

  it('never counts more in flight than the wallet sends', () => {
    const need = walletNeed({
      count: 5,
      gasLimit: 100_000n,
      chargedPrice: 100n,
      maxFee: 200n,
      inFlight: 20,
      float: 0n,
    });
    expect(need).toBe(5n * 100_000n * 100n + 5n * 100_000n * 100n);
  });

  it('adds the float', () => {
    expect(
      walletNeed({ count: 1, gasLimit: 1n, chargedPrice: 1n, maxFee: 1n, inFlight: 1, float: 7n }),
    ).toBe(8n);
  });

  it('refuses a bid below the charged price', () => {
    expect(() =>
      walletNeed({ count: 1, gasLimit: 1n, chargedPrice: 2n, maxFee: 1n, inFlight: 1, float: 0n }),
    ).toThrow(/maxFee/);
  });
});
