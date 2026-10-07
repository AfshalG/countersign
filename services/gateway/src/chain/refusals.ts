import { decodeErrorResult, type Hex } from 'viem';
import { orderVaultAbi } from '@countersign/chain';
import { refusalFor, type Refusal } from '@countersign/shared';

export type DecodedRefusal = Refusal & { error: string };

/**
 * Turns the revert data of a simulated or sent payment into the typed reason the gateway
 * records. Data it cannot decode is a hold, never a pass (money rule 1).
 */
export function decodeRefusal(data: Hex | undefined): DecodedRefusal {
  if (data === undefined) return { error: 'unknown', ...refusalFor('unknown') };
  try {
    const { errorName } = decodeErrorResult({ abi: orderVaultAbi, data });
    return { error: errorName, ...refusalFor(errorName) };
  } catch {
    return { error: 'unknown', ...refusalFor('unknown') };
  }
}
