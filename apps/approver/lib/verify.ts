import { hashTypedData, type Hex } from 'viem';
import { formatUsdc } from '@countersign/shared';

/**
 * Signing exactly what is shown (9 Oct). The phone signs the challenge the gateway gives; if the
 * gateway (or anything between) were tampered with, a screen could say "pay 0.001 to Kalibre"
 * over a challenge for something else. So before Face ID the app recomputes the challenge from the
 * typed data it came with, and the screen shows what that typed data says. A mismatch is refused,
 * and nothing is signed. (The contract computes the digest itself as well: a signature is only
 * ever good for the action it was made for.)
 */

type Field = { name: string; type: string };
type Typed = {
  domain: Record<string, unknown>;
  types: Record<string, Field[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** Numbers the gateway sends as strings, back to bigints by their EIP-712 type; structs and arrays too. */
function revive(types: Record<string, Field[]>, type: string, value: unknown): unknown {
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2);
    return Array.isArray(value) ? value.map((v) => revive(types, inner, v)) : value;
  }
  if (/^u?int\d*$/.test(type) && (typeof value === 'string' || typeof value === 'number'))
    return BigInt(value);
  const struct = types[type];
  if (struct && typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    return Object.fromEntries(struct.map((f) => [f.name, revive(types, f.type, v[f.name])]));
  }
  return value;
}

function typedOf(td: unknown): Typed | null {
  if (typeof td !== 'object' || td === null) return null;
  const t = td as Partial<Typed>;
  if (!t.domain || !t.types || typeof t.primaryType !== 'string' || !t.message) return null;
  if (!t.types[t.primaryType]) return null;
  return t as Typed;
}

/** Whether `challenge` is exactly the EIP-712 digest of this typed data. */
export function signedMatches(td: unknown, challenge: string): boolean {
  const t = typedOf(td);
  if (!t) return false;
  try {
    const domain = { ...t.domain };
    if (typeof domain.chainId === 'string') domain.chainId = Number(domain.chainId);
    const types = Object.fromEntries(Object.entries(t.types).filter(([k]) => k !== 'EIP712Domain'));
    // The shape is checked at run time here, so viem's compile-time typing is set aside.
    const hash = hashTypedData as unknown as (p: Record<string, unknown>) => Hex;
    const digest = hash({
      domain,
      types,
      primaryType: t.primaryType,
      message: revive(t.types, t.primaryType, t.message),
    });
    return digest.toLowerCase() === (challenge as Hex).toLowerCase();
  } catch {
    return false;
  }
}

/** For a payment: the amount and the address the signature pays, read from the typed data. */
export function whatIsPaid(td: unknown): { amountUsdc: string; payTo: string } | null {
  const t = typedOf(td);
  if (t?.primaryType !== 'Payment') return null;
  const { amount, payTo } = t.message;
  if ((typeof amount !== 'string' && typeof amount !== 'number') || typeof payTo !== 'string')
    return null;
  return { amountUsdc: formatUsdc(BigInt(amount)), payTo };
}

/** Refuses, before any Face ID prompt, to sign a challenge that is not its typed data's digest. */
export function mustMatch(td: unknown, challenge: string): void {
  if (!signedMatches(td, challenge))
    throw new Error(
      'What this screen was asked to sign does not match what it shows, so nothing was signed. Reload the page; if it happens again, do not approve anything and tell your team.',
    );
}
