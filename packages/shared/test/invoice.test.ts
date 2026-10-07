import { describe, expect, it } from 'vitest';
import vectors from './fixtures/invoice-ids.json' with { type: 'json' };
import { invoiceHash, normalizeInvoiceNumber, supplierId } from '../src/invoice.js';

describe('invoice identity', () => {
  it('names a supplier by the keccak256 of its slug', () => {
    expect(supplierId(vectors.supplier)).toBe(vectors.supplierId);
  });

  it.each(vectors.cases)('normalizes $input and hashes it as the vectors say', (c) => {
    expect(normalizeInvoiceNumber(c.input)).toBe(c.normalized);
    expect(invoiceHash(vectors.supplierId as `0x${string}`, c.input)).toBe(c.hash);
  });

  it('gives the same supplier’s same invoice one identity, and a different supplier another', () => {
    const other = supplierId('another-supplier');
    expect(invoiceHash(vectors.supplierId as `0x${string}`, 'INV-0042')).not.toBe(
      invoiceHash(other, 'INV-0042'),
    );
  });

  it('refuses an empty or overlong invoice number', () => {
    expect(() => normalizeInvoiceNumber('   ')).toThrow(/empty/);
    expect(() => normalizeInvoiceNumber('X'.repeat(129))).toThrow(/128/);
  });
});
