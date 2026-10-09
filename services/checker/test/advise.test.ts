import { describe, expect, it } from 'vitest';
import { supplierId, supplierSlug } from '@countersign/shared';
import { documentFor, KALIBRE } from '../../../apps/supplier/lib/documents';
import { asText, render } from '../../../apps/supplier/lib/render';
import { advise, type AdviseInput } from '../src/advise.js';
import type { Model, Question } from '../src/model.js';

/**
 * Slice 17: advice on an invoice paid by bank transfer. The same reading and the same findings as
 * a USDC check, the bank account compared with the one on file, and the model asked only when code
 * found nothing definite. It never signs: a bank transfer cannot be stopped from outside the bank.
 */
const ACCOUNT = '0x8f1431D15E547a1073b064e73F0C61372CcEA739';
const KALIBRE_ID = supplierId(supplierSlug('Kalibre Studio'));
const ON_FILE = { holder: KALIBRE.bank.holder, iban: KALIBRE.bank.iban, bic: KALIBRE.bank.bic };

class FakeModel implements Model {
  readonly name = 'fake';
  calls = 0;
  asked: Question[] = [];
  constructor(
    private readonly answer: (q: Question) => number,
    private readonly fail = false,
  ) {}
  ask(_state: unknown, questions: readonly Question[]) {
    this.calls++;
    this.asked = [...questions];
    if (this.fail) return Promise.reject(new Error('model unavailable'));
    return Promise.resolve({
      answers: Object.fromEntries(questions.map((q) => [q.key, this.answer(q)])),
      model: 'fake-v1',
    });
  }
}
const allFine = (q: Question) => (q.key === 'same_supplier' || q.key === 'on_order' ? 0.95 : 0.05);

type Id = Parameters<typeof documentFor>[0];
const inputFor = (id: Id, format: 'html' | 'text' = 'html', onFile = ON_FILE): AdviseInput => {
  const d = documentFor(id, ACCOUNT);
  return {
    order: {
      supplierId: KALIBRE_ID,
      supplierName: 'Kalibre Studio',
      addressOnFile: KALIBRE.payTo,
      quote: { html: render(documentFor('q-2210', ACCOUNT)) },
    },
    bankOnFile: onFile,
    invoice: format === 'html' ? { html: render(d) } : { text: asText(d) },
  };
};

describe('advice on a bank-transfer invoice', () => {
  it('matches Kalibre’s clean bank invoice, from its page and from its text', async () => {
    for (const format of ['html', 'text'] as const) {
      const model = new FakeModel(allFine);
      const a = await advise(inputFor('ks-1008', format), { model });
      expect(a, format).toMatchObject({ advice: 'match' });
      expect(a.reason).toBeUndefined();
      expect(a.evidence.read.bank).toMatchObject({
        ibans: [{ value: 'GB29NWBK60161331926819', valid: true }],
      });
      expect(model.calls).toBe(1);
      // The bank question replaces the USDC one.
      expect(model.asked.map((q) => q.key)).toContain('bank_elsewhere');
      expect(model.asked.map((q) => q.key)).not.toContain('pays_elsewhere');
      expect(model.asked.find((q) => q.key === 'bank_elsewhere')?.text).toContain(
        'GB29 NWBK 6016 1331 9268 19',
      );
    }
  });

  it('calls “we have moved to a new bank” a mismatch in code, without asking the model', async () => {
    const model = new FakeModel(allFine);
    const a = await advise(inputFor('ks-1007'), { model });
    expect(a).toMatchObject({ advice: 'mismatch', reason: 'bank_account_mismatch' });
    expect(model.calls).toBe(0);
    const said = a.evidence.findings
      .filter((f) => !f.ok)
      .map((f) => f.detail)
      .join(' ');
    expect(said).toContain('GB33 BUKB 2020 1555 5555 55');
  });

  it('still catches what a USDC check catches: hidden instructions, another supplier, dearer prices', async () => {
    expect(await advise(inputFor('ks-1005'), { model: new FakeModel(allFine) })).toMatchObject({
      advice: 'mismatch',
      reason: 'hidden_instructions',
    });
    expect(await advise(inputFor('nw-77'), { model: new FakeModel(allFine) })).toMatchObject({
      advice: 'mismatch',
      reason: 'supplier_mismatch',
    });
    expect(await advise(inputFor('ks-1004'), { model: new FakeModel(allFine) })).toMatchObject({
      advice: 'mismatch',
      reason: 'amount_mismatch',
    });
  });

  it('is unsure about an invoice with no bank details, or a supplier with no account on file', async () => {
    expect(await advise(inputFor('ks-1001'), { model: new FakeModel(allFine) })).toMatchObject({
      advice: 'unsure',
      reason: 'checker_unsure',
    });
    const none = { ...inputFor('ks-1008'), bankOnFile: null };
    expect(await advise(none, { model: new FakeModel(allFine) })).toMatchObject({
      advice: 'unsure',
    });
  });

  it('lets the model add a concern, never take one away', async () => {
    const worried = new FakeModel((q) => (q.key === 'bank_elsewhere' ? 0.9 : allFine(q)));
    expect(await advise(inputFor('ks-1008'), { model: worried })).toMatchObject({
      advice: 'mismatch',
      reason: 'bank_account_mismatch',
    });
    const torn = new FakeModel((q) => (q.key === 'same_supplier' ? 0.5 : allFine(q)));
    expect(await advise(inputFor('ks-1008'), { model: torn })).toMatchObject({
      advice: 'unsure',
      reason: 'checker_unsure',
    });
  });

  it('is unsure, never a match, when the model does not answer', async () => {
    const a = await advise(inputFor('ks-1008'), { model: new FakeModel(allFine, true) });
    expect(a).toMatchObject({ advice: 'unsure', reason: 'checker_unavailable' });
    expect(a.evidence.error).toMatch(/unavailable/);
  });
});
