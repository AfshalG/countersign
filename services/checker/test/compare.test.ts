import { describe, expect, it } from 'vitest';
import { invoiceHash, supplierId, supplierSlug } from '@countersign/shared';
import { documentFor, KALIBRE, lookAlike } from '../../../apps/supplier/lib/documents';
import { render } from '../../../apps/supplier/lib/render';
import { codeChecks } from '../src/compare.js';
import { readInvoice } from '../src/read.js';
import type { OrderFacts, PaymentFacts } from '../src/types.js';

const ACCOUNT = '0x8f1431D15E547a1073b064e73F0C61372CcEA739';
const VAULT = '0x6c033066C05Eb524119c8C830F937C4bbd17E426';
const KALIBRE_ID = supplierId(supplierSlug('Kalibre Studio'));
const order: OrderFacts = {
  supplierId: KALIBRE_ID,
  supplierName: 'Kalibre Studio',
  addressOnFile: KALIBRE.payTo,
  quote: { html: render(documentFor('q-2210', ACCOUNT)) },
};
const read = (id: Parameters<typeof documentFor>[0]) =>
  readInvoice({ html: render(documentFor(id, ACCOUNT)) });
/** The payment an agent would send for this document, as it is printed. */
const paymentFor = (id: Parameters<typeof documentFor>[0], change: Partial<PaymentFacts> = {}) => {
  const d = documentFor(id, ACCOUNT);
  return {
    chainId: 10143,
    vault: VAULT,
    amount: BigInt(Math.round(Number(d.totalUsdc) * 1e6)),
    invoiceHash: invoiceHash(KALIBRE_ID, d.number),
    payTo: d.payTo,
    deadline: 2_000_000_000n,
    ...change,
  } satisfies PaymentFacts;
};
const held = (
  id: Parameters<typeof documentFor>[0],
  change: Partial<PaymentFacts> = {},
  o = order,
) => codeChecks(read(id), paymentFor(id, change), o).hold;

describe('the checker’s code checks (they alone decide clear, D27)', () => {
  it('passes a clean invoice at the quote’s price, every line matched to the quote', () => {
    const r = codeChecks(read('ks-1001'), paymentFor('ks-1001'), order);
    expect(r.hold).toBeNull();
    expect(r.unmatched).toEqual([]);
    expect(r.findings.every((f) => f.ok)).toBe(true);
  });

  it('holds a unit price above the quote’s (the padded total)', () => {
    expect(held('ks-1004')).toBe('amount_mismatch');
  });

  it('leaves a line that is not on the quote for the model to judge (the padded line)', () => {
    const r = codeChecks(read('ks-1003'), paymentFor('ks-1003'), order);
    expect(r.hold).toBeNull();
    expect(r.unmatched.map((l) => l.description)).toEqual(['Rush delivery']);
  });

  it('holds text a person cannot see (the hijack), whatever else is right', () => {
    expect(held('ks-1005')).toBe('hidden_instructions');
  });

  it('holds a payment to an address the invoice does not print', () => {
    expect(held('ks-1002', { payTo: KALIBRE.payTo })).toBe('address_mismatch');
    expect(lookAlike(KALIBRE.payTo)).not.toBe(KALIBRE.payTo);
  });

  it('holds an invoice from another supplier than the order’s', () => {
    const d = documentFor('nw-77', ACCOUNT);
    expect(held('nw-77', { invoiceHash: invoiceHash(KALIBRE_ID, d.number) })).toBe(
      'supplier_mismatch',
    );
  });

  it('holds an amount that is not the invoice’s total', () => {
    expect(held('ks-1001', { amount: 2_000n })).toBe('amount_mismatch');
  });

  it('holds a payment for another invoice than the document', () => {
    expect(held('ks-1001', { invoiceHash: invoiceHash(KALIBRE_ID, 'KS-9999') })).toBe(
      'checker_unsure',
    );
  });

  it('holds what it cannot read', () => {
    expect(codeChecks(readInvoice({ text: 'hello' }), paymentFor('ks-1001'), order).hold).toBe(
      'checker_unsure',
    );
  });

  it('without a quote on file, sends every line to the model and holds nothing for it', () => {
    const r = codeChecks(read('ks-1001'), paymentFor('ks-1001'), { ...order, quote: null });
    expect(r.hold).toBeNull();
    expect(r.unmatched).toHaveLength(1);
  });
});

describe('what the evidence says about the quote', () => {
  it('tells a quote it cannot read apart from no quote at all', () => {
    const unreadable = codeChecks(read('ks-1001'), paymentFor('ks-1001'), {
      ...order,
      quote: { text: 'Kalibre Studio — a quote with no priced lines' },
    });
    expect(unreadable.findings.find((f) => f.check === 'price')?.detail).toMatch(
      /quote has no lines the checker can read/,
    );
    const none = codeChecks(read('ks-1001'), paymentFor('ks-1001'), { ...order, quote: null });
    expect(none.findings.find((f) => f.check === 'price')?.detail).toMatch(/no quote on file/);
  });
});
