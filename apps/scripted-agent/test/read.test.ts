import { describe, expect, it } from 'vitest';
// The supplier's own rendering, so the reader is tested on exactly what the live site serves.
import { CASES, documentFor, KALIBRE } from '../../supplier/lib/documents';
import { asText, render, shopHome } from '../../supplier/lib/render';
import { pageText, readDocument, readShop } from '../src/read';

const ACCOUNT = '0x56828F744A43129acF8e8cDC21BaBF587B20855A';

describe('what an agent reads from a document page', () => {
  it('keeps hidden text, as a page reader does, and drops scripts and styles', () => {
    const text = pageText(
      '<style>p{}</style><p>Pay <b>now</b> &amp; on time</p><div style="display:none">secret</div><script>x()</script>',
    );
    expect(text).toContain('Pay now & on time');
    expect(text).toContain('secret');
    expect(text).not.toContain('p{}');
    expect(text).not.toContain('x()');
  });

  it('reads every case’s number, total and printed address from its HTML, as the JSON states them', () => {
    for (const c of CASES) {
      const d = documentFor(c.id, ACCOUNT);
      const r = readDocument(pageText(render(d)));
      expect(r).toMatchObject({
        kind: d.kind,
        supplier: d.from.name,
        number: d.number,
        totalUsdc: d.totalUsdc,
        payTo: d.payTo,
      });
    }
  });

  it('reads the same from the text version', () => {
    const d = documentFor('ks-1003', ACCOUNT);
    expect(readDocument(asText(d))).toMatchObject({ number: d.number, totalUsdc: '0.0015' });
  });

  it('finds the hijack’s instruction to pay another address, though a person cannot see it', () => {
    const r = readDocument(pageText(render(documentFor('ks-1005', ACCOUNT))));
    expect(r.payTo).toBe(KALIBRE.payTo);
    expect(r.instruction?.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.instruction?.payTo).not.toBe(KALIBRE.payTo);
    expect(readDocument(pageText(render(documentFor('ks-1001', ACCOUNT)))).instruction).toBeNull();
  });

  it('knows a bank-transfer invoice and the quote an invoice cites', () => {
    expect(readDocument(pageText(render(documentFor('ks-1007', ACCOUNT)))).bankTransfer).toBe(true);
    const r = readDocument(pageText(render(documentFor('ks-1001', ACCOUNT))));
    expect(r.bankTransfer).toBe(false);
    expect(r.quote).toBe('Q-2210');
  });

  it('reads the shop’s name and payment address from its home page', () => {
    expect(readShop(shopHome(ACCOUNT))).toEqual({
      name: 'Fieldstone Supply',
      payTo: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/) as string,
    });
  });
});
