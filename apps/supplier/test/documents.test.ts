import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { ADDRESS_FILE, CASES, documentFor, FIELDSTONE, KALIBRE, lookAlike } from '../lib/documents';
import { asText, render } from '../lib/render';

const JUDGE = '0x32252f5B45D36F26909cc7E06B7E98c663f30339';
const OTHER = '0x76dB7fE105b80e589EbB1070e54AEAD199AAE951';

describe('Kalibre Studio’s address file (Slice 2 pinned it for the Primus proof)', () => {
  it('is byte-for-byte the file the proof was made over', () => {
    const original = readFileSync(
      new URL(
        '../../../spikes/02-primus/supplier-site/public/.well-known/countersign.json',
        import.meta.url,
      ),
      'utf8',
    );
    expect(ADDRESS_FILE).toBe(original);
    expect(JSON.parse(ADDRESS_FILE)).toEqual({ payTo: KALIBRE.payTo });
  });
});

describe('the demo documents', () => {
  it('has every case the architecture lists, each with what Countersign does today', () => {
    expect(CASES.map((c) => c.id)).toEqual([
      'q-2210',
      'q-2211',
      'ks-1001',
      'ks-1002',
      'ks-1003',
      'ks-1004',
      'ks-1005',
      'nw-77',
      'ks-1006',
      'ks-1007',
      'fs-checkout',
      'fs-checkout-v2',
    ]);
    for (const c of CASES) expect(c.today.length).toBeGreaterThan(10);
  });

  it('pays the address on file in a clean invoice, at 0.001 USDC (under a new address’s 0.002 cap)', () => {
    const d = documentFor('ks-1001', JUDGE);
    expect(d).toMatchObject({ kind: 'invoice', payTo: KALIBRE.payTo, totalUsdc: '0.001' });
    expect(d.number).toMatch(/^KS-1001-/);
  });

  it('numbers invoices per account, so only the duplicate case repeats a number', () => {
    expect(documentFor('ks-1001', JUDGE).number).not.toBe(documentFor('ks-1001', OTHER).number);
    expect(documentFor('ks-1001', JUDGE).number).toBe(documentFor('ks-1001', JUDGE).number);
    const numbers = CASES.filter((c) => c.kind === 'invoice').map(
      (c) => documentFor(c.id, JUDGE).number,
    );
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('builds the changed address as address poisoning does: same start and end', () => {
    const d = documentFor('ks-1002', JUDGE);
    expect(d.payTo).toBe(lookAlike(KALIBRE.payTo));
    expect(d.payTo).toBe(getAddress(d.payTo));
    expect(d.payTo.slice(0, 8).toLowerCase()).toBe(KALIBRE.payTo.slice(0, 8).toLowerCase());
    expect(d.payTo.slice(-4).toLowerCase()).toBe(KALIBRE.payTo.slice(-4).toLowerCase());
    expect(d.notes.join(' ')).toMatch(/changed our payment details/i);
  });

  it('pads the invoice in two ways: an extra line, and a higher total', () => {
    const line = documentFor('ks-1003', JUDGE);
    expect(line.lines).toHaveLength(2);
    expect(line.totalUsdc).toBe('0.0015');
    expect(documentFor('ks-1004', JUDGE).totalUsdc).toBe('0.0018');
  });

  it('hides the hijack’s instruction from a person but not from an automated reader', () => {
    const d = documentFor('ks-1005', JUDGE);
    expect(d.payTo).toBe(KALIBRE.payTo); // the printed address is right
    expect(d.hidden).toMatch(/ignore|instead|urgent/i);
    const html = render(d);
    expect(html).toContain(d.hidden);
    expect(html).toMatch(/display:\s*none|font-size:\s*0/);
    expect(asText(d)).toContain(d.hidden); // what an agent's page reader sees
  });

  it('asks for more than the order holds in the over-the-order case', () => {
    expect(Number(documentFor('ks-1006', JUDGE).totalUsdc)).toBeGreaterThan(0.005);
  });

  it('comes from another supplier in the wrong-supplier case, and from a bank in the bank case', () => {
    expect(documentFor('nw-77', JUDGE).party).toBe('northwind');
    const bank = documentFor('ks-1007', JUDGE);
    expect(bank.bank?.iban).toBeDefined();
    expect(bank.notes.join(' ')).toMatch(/new bank/i);
  });

  it('runs the demo shop’s checkout clean, and swapped to a look-alike', () => {
    expect(documentFor('fs-checkout', JUDGE).payTo).toBe(FIELDSTONE.payTo);
    expect(documentFor('fs-checkout-v2', JUDGE).payTo).toBe(lookAlike(FIELDSTONE.payTo));
  });

  it('quotes Kalibre at its own address, and the poisoned quote at one its file does not list', () => {
    expect(documentFor('q-2210', JUDGE)).toMatchObject({ kind: 'quote', payTo: KALIBRE.payTo });
    expect(documentFor('q-2211', JUDGE).payTo).not.toBe(KALIBRE.payTo);
  });

  it('refuses an unknown case', () => {
    expect(() => documentFor('ks-9999' as never, JUDGE)).toThrow(/unknown/);
  });
});
