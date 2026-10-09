import { describe, expect, it } from 'vitest';
import { ibanValid, routingValid, spacedIban } from '../src/bank.js';

/** Slice 17: the check digits of bank account numbers, shared by the checker and the gateway. */
describe('bank account check digits', () => {
  it('checks an IBAN (ISO 13616, mod 97), spaced or not', () => {
    expect(ibanValid('GB29NWBK60161331926819')).toBe(true);
    expect(ibanValid('GB29 NWBK 6016 1331 9268 19')).toBe(true);
    expect(ibanValid('GB33BUKB20201555555555')).toBe(true);
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('GB30NWBK60161331926819')).toBe(false);
    expect(ibanValid('not an iban')).toBe(false);
  });

  it('checks a US routing number (weights 3, 7, 1)', () => {
    expect(routingValid('021000021')).toBe(true);
    expect(routingValid('021000022')).toBe(false);
    expect(routingValid('12345')).toBe(false);
  });

  it('prints an IBAN in groups of four', () => {
    expect(spacedIban('GB29NWBK60161331926819')).toBe('GB29 NWBK 6016 1331 9268 19');
  });
});
