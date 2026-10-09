import { describe, expect, it } from 'vitest';
import vectors from './fixtures/invoice-ids.json' with { type: 'json' };
import {
  invoiceHash,
  invoiceSkeleton,
  normalizeInvoiceNumber,
  supplierId,
  supplierSlug,
} from '../src/invoice.js';

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

describe('an invoice number’s skeleton: what it looks like to a person (9 Oct)', () => {
  it('is the same for numbers a person cannot tell apart', () => {
    const one = invoiceSkeleton('INV-1001');
    expect(one).toBe('1NV1001');
    for (const lookAlike of [
      'INV-1001​', // a zero-width space
      'INV‭-1001', // a direction override
      'inv 1001', // case and separators
      'INV-l001', // a small L for a one
      'INV-1OO1', // capital Os for zeros
      'ΙNV-1001', // a Greek capital iota
      'INV-1001'.normalize('NFKC'),
      'ＩＮＶ-１００１', // full width
    ])
      expect(invoiceSkeleton(lookAlike), JSON.stringify(lookAlike)).toBe(one);
  });

  it('differs for numbers that differ', () => {
    expect(invoiceSkeleton('INV-1002')).not.toBe(invoiceSkeleton('INV-1001'));
    expect(invoiceSkeleton('KS-1001-R7')).not.toBe(invoiceSkeleton('KS-1001-R8'));
  });

  it('keeps a number written wholly in another alphabet', () => {
    expect(invoiceSkeleton('СЧ-001')).toBe('СЧ001');
  });
});
