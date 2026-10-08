import { decodeErrorResult, type Hex } from 'viem';
import { countersignAccountAbi, orderVaultAbi } from '@countersign/chain';
import { refusalFor, type Refusal } from '@countersign/shared';

export type DecodedRefusal = Refusal & { error: string };

/**
 * Turns the revert data of a simulated or sent payment into the typed reason the gateway
 * records. Data it cannot decode is a hold, never a pass (money rule 1).
 */
export function decodeRefusal(data: Hex | undefined): DecodedRefusal {
  if (data === undefined) return { error: 'unknown', ...refusalFor('unknown') };
  try {
    // A vault's owner checks run in its account (D36): its errors can come from either.
    const { errorName } = decodeErrorResult({
      abi: [...orderVaultAbi, ...countersignAccountAbi],
      data,
    });
    return { error: errorName, ...refusalFor(errorName) };
  } catch {
    return { error: 'unknown', ...refusalFor('unknown') };
  }
}
