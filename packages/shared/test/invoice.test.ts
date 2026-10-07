import { describe, expect, it } from 'vitest';
import vectors from './fixtures/invoice-ids.json' with { type: 'json' };
import { invoiceHash, normalizeInvoiceNumber, supplierId, supplierSlug } from '../src/invoice.js';

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

describe('supplierSlug (a proposal names its supplier; the account knows it by slug)', () => {
  it('gives the slug Slice 5 used for the demo supplier', () => {
    expect(supplierSlug('Kalibre Studio')).toBe('kalibre-studio');
    expect(supplierId(supplierSlug('Kalibre Studio'))).toBe(supplierId('kalibre-studio'));
  });

  it('ignores case, spacing and punctuation, so one supplier never becomes two', () => {
    for (const name of [
      '  KALIBRE  studio ',
      'Kalibre-Studio',
      'Kalibre Studio.',
      'ｋａｌｉｂｒｅ studio',
    ])
      expect(supplierSlug(name)).toBe('kalibre-studio');
  });

  it('refuses a name with nothing to identify it', () => {
    expect(() => supplierSlug(' -- ')).toThrow(/name/);
  });
});
