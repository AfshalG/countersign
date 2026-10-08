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

describe('reading the text an agent sends, in the agent’s own format', () => {
  it('reads the scripted agent’s page text (cells run together)', async () => {
    const { pageText } = await import('../../../apps/scripted-agent/src/read');
    for (const id of ['ks-1003', 'q-2210', 'ks-1005'] as const) {
      const d = documentFor(id, ACCOUNT);
      const r = readInvoice({ text: pageText(render(d)) });
      expect(r, id).toMatchObject({
        number: d.number,
        sender: d.from.name,
        total: units(d.totalUsdc),
        payTo: d.payTo,
      });
      expect(
        r.lines.map((l) => [l.description, l.quantity, l.unit]),
        id,
      ).toEqual(d.lines.map((l) => [l.description, l.quantity, units(l.unitUsdc)]));
    }
  });

  it('reads a markdown table, as a chat agent writes one', () => {
    const r = readInvoice({
      text: [
        'Kalibre Studio · Product photography',
        'Invoice KS-1003-0855A',
        '| Item | Qty | Unit price | Amount |',
        '|---|---|---|---|',
        '| Product photos, white background | 10 | 0.0001 USDC | 0.001 USDC |',
        '| Rush delivery | 1 | 0.0005 USDC | 0.0005 USDC |',
        '| Total | | | 0.0015 USDC |',
        'Pay in USDC on Monad to 0x90f9931B748B26763161a8191C178Fe425C25fEc',
      ].join('\n'),
    });
    expect(r.lines.map((l) => l.description)).toEqual([
      'Product photos, white background',
      'Rush delivery',
    ]);
    expect(r.total).toBe(1_500n);
  });
});
