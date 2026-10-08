import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, stringToHex } from 'viem';
import { usdc } from '@countersign/shared';
import { demoInvoice, lookAlike, DEMO_INVOICE_KINDS, DEMO_QUOTE } from '../../src/demo/invoices.js';
import { demoPlan, KALIBRE } from '../../src/demo/plan.js';
// The checker's own reader: the demo documents must read back exactly as the checker reads them.
import { readInvoice } from '../../../checker/src/read.js';

describe('demo invoices (what the demo agent pays into a judge’s account)', () => {
  it('makes a look-alike address the way address poisoning does: same start and end', () => {
    const fake = lookAlike(KALIBRE.payTo);
    expect(fake).toBe(getAddress(fake)); // a valid checksummed address
    expect(fake.toLowerCase().slice(0, 8)).toBe(KALIBRE.payTo.toLowerCase().slice(0, 8));
    expect(fake.toLowerCase().slice(-4)).toBe(KALIBRE.payTo.toLowerCase().slice(-4));
    expect(fake.toLowerCase()).not.toBe(KALIBRE.payTo.toLowerCase());
  });

  it('pays at most 0.0012 USDC, under the 0.002 cap on a new supplier address (Slice 5)', () => {
    expect(demoInvoice('clean', KALIBRE.payTo).amount).toBe('0.001');
    expect(demoInvoice('changed_address', KALIBRE.payTo).amount).toBe('0.001');
    expect(demoInvoice('amount_mismatch', KALIBRE.payTo).amount).toBe('0.0012');
  });

  it('builds each kind: clean pays the address on file, the others are what gets held', () => {
    expect(demoInvoice('clean', KALIBRE.payTo).payTo).toBe(KALIBRE.payTo);
    expect(demoInvoice('changed_address', KALIBRE.payTo).payTo).toBe(lookAlike(KALIBRE.payTo));
    const amount = demoInvoice('amount_mismatch', KALIBRE.payTo);
    expect(amount.payTo).toBe(KALIBRE.payTo);
    for (const kind of DEMO_INVOICE_KINDS)
      expect(demoInvoice(kind, KALIBRE.payTo).document).not.toHaveProperty('testHold');
  });

  it('writes each invoice as text the checker reads back exactly (Slice 10)', () => {
    for (const kind of DEMO_INVOICE_KINDS) {
      const inv = demoInvoice(kind, KALIBRE.payTo);
      const r = readInvoice(inv.document as { text: string });
      expect(r, kind).toMatchObject({
        kind: 'invoice',
        number: inv.number,
        sender: 'Kalibre Studio',
        total: usdc(String(inv.amount)),
        payTo: inv.payTo,
      });
    }
    // The amount demo bills a photo above the quote's price: what the checker holds.
    const [line] = readInvoice(
      demoInvoice('amount_mismatch', KALIBRE.payTo).document as { text: string },
    ).lines;
    expect(line?.unit).toBe(120n);
  });

  it('opens the demo order on a real quote: its hash is the quote’s, and the checker reads it', () => {
    const plan = demoPlan({
      agentKey: KALIBRE.payTo,
      checkerKey: KALIBRE.payTo,
      now: 1_791_000_000,
    });
    expect(plan.order.orderHash).toBe(keccak256(stringToHex(DEMO_QUOTE)));
    expect(readInvoice({ text: DEMO_QUOTE })).toMatchObject({
      kind: 'quote',
      total: 5_000n,
      lines: [{ description: 'Product photos, white background', quantity: 50, unit: 100n }],
    });
  });

  it('gives every invoice its own number, so none is mistaken for a resent one', () => {
    const numbers = new Set(
      Array.from({ length: 50 }, () => demoInvoice('clean', KALIBRE.payTo).number),
    );
    expect(numbers.size).toBe(50);
  });
});
