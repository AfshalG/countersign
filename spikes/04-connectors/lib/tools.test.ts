import { describe, expect, it } from 'vitest';
import { APPROVAL_PAGE, checkPayment, KNOWN_SUPPLIERS } from './tools.js';

const kalibre = KNOWN_SUPPLIERS[0];

describe('checkPayment', () => {
  it('settles a payment to the address on file', () => {
    const r = checkPayment({ supplier: 'Kalibre Studio', amount: 4200, payTo: kalibre.payTo });
    expect(r.status).toBe('settled');
  });

  it('matches the address case-insensitively but compares every character', () => {
    expect(
      checkPayment({ supplier: 'Kalibre Studio', amount: 4200, payTo: kalibre.payTo.toLowerCase() })
        .status,
    ).toBe('settled');
  });

  it('holds a look-alike address with the reason and an approval link', () => {
    const lookalike = `${kalibre.payTo.slice(0, -1)}${kalibre.payTo.endsWith('c') ? 'd' : 'c'}`;
    const r = checkPayment({ supplier: 'Kalibre Studio', amount: 4200, payTo: lookalike });
    expect(r).toMatchObject({ status: 'held', reason: 'address_mismatch' });
    expect(r.status === 'held' && r.approvalUrl.startsWith(APPROVAL_PAGE)).toBe(true);
    expect(r.message).toContain('differs');
  });

  it('holds an unknown supplier', () => {
    const r = checkPayment({ supplier: 'Nobody Ltd', amount: 10, payTo: kalibre.payTo });
    expect(r).toMatchObject({ status: 'held', reason: 'supplier_unknown' });
  });

  it('holds an amount over the order', () => {
    const r = checkPayment({
      supplier: 'Kalibre Studio',
      amount: kalibre.orderLimit + 1,
      payTo: kalibre.payTo,
    });
    expect(r).toMatchObject({ status: 'held', reason: 'over_limit' });
  });

  it.each([
    ['a non-address', { supplier: 'Kalibre Studio', amount: 1, payTo: 'not an address' }],
    ['a negative amount', { supplier: 'Kalibre Studio', amount: -5, payTo: kalibre.payTo }],
    ['a zero amount', { supplier: 'Kalibre Studio', amount: 0, payTo: kalibre.payTo }],
    ['an empty supplier', { supplier: '', amount: 1, payTo: kalibre.payTo }],
  ])('refuses %s with an error instead of guessing', (_label, input) => {
    expect(() => checkPayment(input)).toThrow();
  });
});
