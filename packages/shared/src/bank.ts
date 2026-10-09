/**
 * Check digits of bank account numbers (Slice 17), shared by the checker (reading an invoice) and
 * the gateway (an owner putting an account on file): a number that fails them is a misprint or a
 * misread, never compared as if it were right.
 */

/** An IBAN without spaces or dashes, upper case. */
export const compactIban = (iban: string) => iban.replace(/[\s-]/g, '').toUpperCase();

/** ISO 13616: the first four characters moved to the end, letters as numbers, mod 97 is 1. */
export function ibanValid(iban: string): boolean {
  const s = compactIban(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  let rest = 0;
  for (const ch of s.slice(4) + s.slice(0, 4)) {
    const n = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** An ABA routing number's check digit: weights 3, 7, 1. */
export function routingValid(routing: string): boolean {
  if (!/^[0-9]{9}$/.test(routing)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(routing.charAt(i)) * (w[i] ?? 0);
  return sum % 10 === 0;
}

/** An IBAN printed in groups of four, the way people write them. */
export const spacedIban = (iban: string) => compactIban(iban).replace(/(.{4})(?=.)/g, '$1 ');
