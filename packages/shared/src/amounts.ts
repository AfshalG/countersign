/** USDC has 6 decimals on Monad (testnet 0x534b…43A3). */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

/**
 * A USDC amount from a plain decimal string ("12.50") to base units (12_500_000n). Amounts never
 * pass through floating point: a float cannot hold most cents exactly.
 */
export function usdc(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (!match) {
    throw new Error(
      `not a USDC amount: "${amount}" (a non-negative decimal with at most ${String(USDC_DECIMALS)} places, e.g. "12.50")`,
    );
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(USDC_DECIMALS, '0');
  return BigInt(whole) * SCALE + BigInt(fraction);
}

/** Base units to a decimal string with at least two places: 12_500_000n is "12.50", 1n is "0.000001". */
export function formatUsdc(units: bigint): string {
  if (units < 0n) throw new Error('a USDC amount cannot be negative');
  const whole = units / SCALE;
  const fraction = (units % SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fraction.padEnd(2, '0')}`;
}
