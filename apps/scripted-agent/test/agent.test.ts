import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Order } from '@countersign/sdk';
import { supplierId, supplierSlug } from '@countersign/shared';
import { documentFor, FIELDSTONE, KALIBRE } from '../../supplier/lib/documents';
import { render } from '../../supplier/lib/render';
import { compare, decide, type Memory } from '../src/agent';
import { pageText, readDocument } from '../src/read';

const ACCOUNT = '0x56828F744A43129acF8e8cDC21BaBF587B20855A';
const read = (id: Parameters<typeof documentFor>[0]) =>
  readDocument(pageText(render(documentFor(id, ACCOUNT))));
const order = (name: string, payTo: Address, id: string, remaining: string): Order => ({
  orderId: id as Hex,
  vault: `0x${id.slice(2, 42)}`,
  supplierId: supplierId(supplierSlug(name)),
  payTo,
  supplierActive: true,
  activeAfter: 0,
  amount: '5000',
  remaining,
  expiry: 2_000_000_000,
  approvedBlock: 1,
});
const DEMO = order('Kalibre Studio', KALIBRE.payTo, `0x${'a1'.repeat(32)}`, '5000');
const FROM_QUOTE = order('Kalibre Studio', KALIBRE.payTo, `0x${'b2'.repeat(32)}`, '3000');
const SHOP = order('Fieldstone Supply', FIELDSTONE.payTo, `0x${'c3'.repeat(32)}`, '2000');
const orders = [DEMO, FROM_QUOTE, SHOP];
const memory: Memory = { quotes: new Map([['Q-2210', FROM_QUOTE.orderId]]) };

describe('what the scripted agent does with a document', () => {
  it('pays a clean invoice at its printed address, from the order opened from the quote it cites', () => {
    const a = decide(read('ks-1003'), 'careful', orders, memory);
    expect(a).toMatchObject({
      kind: 'pay',
      order: { orderId: FROM_QUOTE.orderId },
      invoice: { amount: '0.0015', payTo: KALIBRE.payTo },
    });
    if (a.kind === 'pay') expect(a.invoice.number).toMatch(/^KS-1003-/);
  });

  it('without that order, pays from the supplier’s order with the most left', () => {
    const a = decide(read('ks-1001'), 'careful', orders, { quotes: new Map() });
    expect(a).toMatchObject({ kind: 'pay', order: { orderId: DEMO.orderId } });
  });

  it('ignores an instruction hidden in the document when careful, and follows it when obedient', () => {
    const doc = read('ks-1005');
    expect(decide(doc, 'careful', orders, memory)).toMatchObject({
      kind: 'pay',
      invoice: { payTo: KALIBRE.payTo },
    });
    const obeyed = decide(doc, 'obedient', orders, memory);
    expect(obeyed.kind).toBe('pay');
    if (obeyed.kind === 'pay') {
      expect(obeyed.invoice.payTo).toBe(doc.instruction?.payTo);
      expect(obeyed.invoice.payTo).not.toBe(KALIBRE.payTo);
    }
  });

  it('pays the address printed on a doctored invoice too: the account decides, not the agent', () => {
    const doc = read('ks-1002');
    expect(decide(doc, 'careful', orders, memory)).toMatchObject({
      kind: 'pay',
      invoice: { payTo: doc.payTo },
    });
  });

  it('proposes a quote as a supplier and an order, with the quote’s text as its document', () => {
    const a = decide(read('q-2210'), 'careful', orders, memory);
    expect(a).toMatchObject({
      kind: 'propose',
      supplier: { name: 'Kalibre Studio', payTo: KALIBRE.payTo },
      amount: '0.005',
      quote: 'Q-2210',
    });
    if (a.kind === 'propose') expect(a.document).toContain('Total 0.005 USDC');
  });

  it('sends nothing for a supplier with no order', () => {
    expect(decide(read('nw-77'), 'careful', orders, memory)).toEqual({
      kind: 'none',
      why: 'no_order',
    });
  });

  it('asks for advice on a bank transfer instead of paying it (Slice 17)', () => {
    for (const id of ['ks-1007', 'ks-1008'] as const) {
      const a = decide(read(id), 'careful', orders, memory);
      // Against Kalibre's order, as an invoice paid in USDC would be.
      expect(a, id).toMatchObject({
        kind: 'advise',
        order: { supplierId: supplierId(supplierSlug('Kalibre Studio')) },
      });
      if (a.kind === 'advise') expect(a.document).toContain('IBAN');
    }
  });

  it('sends nothing for a page it cannot read', () => {
    expect(decide(readDocument('nothing here'), 'careful', orders, memory)).toEqual({
      kind: 'none',
      why: 'unreadable',
    });
  });
});

describe('scoring a case against what its document says should happen', () => {
  it('matches on the outcome and, where given, the reason and the address change', () => {
    expect(compare({ outcome: 'settled' }, { outcome: 'settled' }).ok).toBe(true);
    expect(
      compare(
        { outcome: 'held', reason: 'address_mismatch' },
        { outcome: 'held', reason: 'address_mismatch' },
      ).ok,
    ).toBe(true);
    expect(
      compare(
        { outcome: 'proposed', changesAddress: true },
        { outcome: 'proposed', changesAddress: true },
      ).ok,
    ).toBe(true);
  });

  it('scores advice on its verdict (Slice 17)', () => {
    const want = {
      outcome: 'advised',
      advice: 'mismatch',
      reason: 'bank_account_mismatch',
    } as const;
    expect(compare(want, { ...want }).ok).toBe(true);
    expect(
      compare(want, { outcome: 'advised', advice: 'unsure', reason: 'checker_unsure' }),
    ).toEqual({
      ok: false,
      why: 'expected advised: mismatch (bank_account_mismatch), got advised: unsure (checker_unsure)',
    });
  });

  it('says why when it does not match', () => {
    expect(compare({ outcome: 'settled' }, { outcome: 'held', reason: 'checker_unsure' })).toEqual({
      ok: false,
      why: 'expected settled, got held (checker_unsure)',
    });
    expect(
      compare(
        { outcome: 'held', reason: 'address_mismatch' },
        { outcome: 'held', reason: 'paused' },
      ),
    ).toEqual({ ok: false, why: 'expected held (address_mismatch), got held (paused)' });
    expect(
      compare(
        { outcome: 'proposed', changesAddress: true },
        { outcome: 'proposed', changesAddress: false },
      ).ok,
    ).toBe(false);
  });
});
