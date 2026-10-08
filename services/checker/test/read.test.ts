import { describe, expect, it } from 'vitest';
// The supplier site's own rendering: the checker is tested on exactly what an agent was given.
import { CASES, documentFor, KALIBRE } from '../../../apps/supplier/lib/documents';
import { asText, render } from '../../../apps/supplier/lib/render';
import { readInvoice } from '../src/read.js';

const ACCOUNT = '0x8f1431D15E547a1073b064e73F0C61372CcEA739';
const units = (usdc: string) => BigInt(Math.round(Number(usdc) * 1e6));

describe('the checker reads an invoice itself', () => {
  it('reads every case from its HTML exactly as the document states it', () => {
    for (const c of CASES) {
      const d = documentFor(c.id, ACCOUNT);
      const r = readInvoice({ html: render(d) });
      expect(r, c.id).toMatchObject({
        kind: d.kind,
        number: d.number,
        sender: d.from.name,
        total: units(d.totalUsdc),
        payTo: d.payTo,
      });
      expect(
        r.lines.map((l) => [l.description, l.quantity, l.unit, l.amount]),
        c.id,
      ).toEqual(
        d.lines.map((l) => [l.description, l.quantity, units(l.unitUsdc), units(l.totalUsdc)]),
      );
    }
  });

  it('reads the same from the text version', () => {
    for (const id of ['ks-1003', 'ks-1004', 'q-2210'] as const) {
      const d = documentFor(id, ACCOUNT);
      const r = readInvoice({ text: asText(d) });
      expect(r).toMatchObject({ number: d.number, total: units(d.totalUsdc), payTo: d.payTo });
      expect(r.lines).toHaveLength(d.lines.length);
    }
  });

  it('finds text a person cannot see in a page, and never takes printed fields from it', () => {
    const d = documentFor('ks-1005', ACCOUNT);
    const r = readInvoice({ html: render(d) });
    expect(r.hiddenText.join(' ')).toContain('automated payment assistant');
    expect(r.payTo).toBe(KALIBRE.payTo);
    expect(r.machineText).toContain('automated payment assistant');
    expect(readInvoice({ html: render(documentFor('ks-1001', ACCOUNT)) }).hiddenText).toEqual([]);
  });

  it('reads nothing it cannot find, rather than guessing', () => {
    expect(readInvoice({ text: 'hello' })).toMatchObject({
      kind: null,
      number: null,
      total: null,
      payTo: null,
      lines: [],
    });
  });
});
