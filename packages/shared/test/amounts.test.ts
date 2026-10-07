import { describe, expect, it } from 'vitest';
import { formatUsdc, usdc } from '../src/amounts.js';

describe('USDC amounts', () => {
  it('reads decimal strings into base units, without floats', () => {
    expect(usdc('12.50')).toBe(12_500_000n);
    expect(usdc('12')).toBe(12_000_000n);
    expect(usdc('0.000001')).toBe(1n);
    expect(usdc('4200.123456')).toBe(4_200_123_456n);
    expect(usdc('100000000000')).toBe(100_000_000_000_000_000n);
  });

  it('refuses anything that is not a plain non-negative decimal with at most 6 places', () => {
    for (const bad of ['', '-1', '1.2345678', '1e3', '1,000', ' 1', '.5', '1.', 'NaN', '0x10'])
      expect(() => usdc(bad), bad).toThrow(/USDC amount/);
  });

  it('writes base units as a decimal with at least two places', () => {
    expect(formatUsdc(12_500_000n)).toBe('12.50');
    expect(formatUsdc(1n)).toBe('0.000001');
    expect(formatUsdc(0n)).toBe('0.00');
    expect(formatUsdc(4_200_123_456n)).toBe('4200.123456');
    expect(formatUsdc(30_000n)).toBe('0.03');
  });

  it('round-trips', () => {
    for (const s of ['0.01', '12.50', '0.000001', '999999.999999'])
      expect(formatUsdc(usdc(s))).toBe(s);
  });

  it('refuses negative base units', () => {
    expect(() => formatUsdc(-1n)).toThrow(/negative/);
  });
});
