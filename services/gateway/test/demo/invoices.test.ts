import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { demoInvoice, lookAlike, DEMO_INVOICE_KINDS } from '../../src/demo/invoices.js';
import { KALIBRE } from '../../src/demo/plan.js';

describe('demo invoices (what the demo agent pays into a judge’s account)', () => {
  it('makes a look-alike address the way address poisoning does: same start and end', () => {
    const fake = lookAlike(KALIBRE.payTo);
    expect(fake).toBe(getAddress(fake)); // a valid checksummed address
    expect(fake.toLowerCase().slice(0, 8)).toBe(KALIBRE.payTo.toLowerCase().slice(0, 8));
    expect(fake.toLowerCase().slice(-4)).toBe(KALIBRE.payTo.toLowerCase().slice(-4));
    expect(fake.toLowerCase()).not.toBe(KALIBRE.payTo.toLowerCase());
  });

  it('pays 0.001 USDC, under the 0.002 cap on a new supplier address (Slice 5)', () => {
    for (const kind of DEMO_INVOICE_KINDS)
      expect(demoInvoice(kind, KALIBRE.payTo).amount).toBe('0.001');
  });

  it('builds each kind: clean pays the address on file, the others are what gets held', () => {
    expect(demoInvoice('clean', KALIBRE.payTo).payTo).toBe(KALIBRE.payTo);
    expect(demoInvoice('changed_address', KALIBRE.payTo).payTo).toBe(lookAlike(KALIBRE.payTo));
    const amount = demoInvoice('amount_mismatch', KALIBRE.payTo);
    expect(amount.payTo).toBe(KALIBRE.payTo);
    // Held by the stand-in checker until the real one (Slice 10) reads the invoice itself.
    expect(amount.document).toMatchObject({ testHold: 'amount_mismatch' });
    expect(demoInvoice('clean', KALIBRE.payTo).document).not.toHaveProperty('testHold');
  });

  it('gives every invoice its own number, so none is mistaken for a resent one', () => {
    const numbers = new Set(
      Array.from({ length: 50 }, () => demoInvoice('clean', KALIBRE.payTo).number),
    );
    expect(numbers.size).toBe(50);
  });
});
