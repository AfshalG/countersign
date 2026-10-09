import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import {
  OUTCOME,
  decisionTypes,
  evidenceHash,
  reasonHash,
  invoiceHash,
  paymentTypes,
  supplierId,
  supplierSlug,
  vaultDomain,
} from '@countersign/shared';
import { documentFor, KALIBRE } from '../../../apps/supplier/lib/documents';
import { asText, render } from '../../../apps/supplier/lib/render';
import { check, type CheckInput } from '../src/check.js';
import { FallbackModel, type Model, type Question } from '../src/model.js';
import { keySigner, type SignedDecision } from '../src/sign.js';
import type { PaymentFacts } from '../src/types.js';

const ACCOUNT = '0x8f1431D15E547a1073b064e73F0C61372CcEA739';
const VAULT = '0x6c033066C05Eb524119c8C830F937C4bbd17E426';
const KALIBRE_ID = supplierId(supplierSlug('Kalibre Studio'));
const signer = keySigner(generatePrivateKey());

/** A model with fixed answers (yes-probabilities by question), counting its calls. */
class FakeModel implements Model {
  calls = 0;
  asked: Question[] = [];
  constructor(
    readonly name: string,
    private readonly answer: (q: Question) => number,
    private readonly delayMs = 0,
    private readonly fail = false,
  ) {}
  async ask(_state: unknown, questions: readonly Question[], signal: AbortSignal) {
    this.calls++;
    this.asked = [...questions];
    if (this.delayMs > 0)
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(signal.reason as Error);
        });
      });
    if (this.fail) throw new Error('model unavailable');
    return {
      answers: Object.fromEntries(questions.map((q) => [q.key, this.answer(q)])),
      model: `${this.name}-v1`,
    };
  }
}
/** Every question answered the way a clean invoice is: the same supplier, no risks. */
const allFine = (q: Question) => (q.key === 'same_supplier' || q.key === 'on_order' ? 0.95 : 0.05);

type Id = Parameters<typeof documentFor>[0];
function inputFor(
  id: Id,
  change: Partial<PaymentFacts> = {},
  format: 'html' | 'text' = 'html',
): CheckInput {
  const d = documentFor(id, ACCOUNT);
  return {
    payment: {
      chainId: 10143,
      vault: VAULT,
      amount: BigInt(Math.round(Number(d.totalUsdc) * 1e6)),
      invoiceHash: invoiceHash(KALIBRE_ID, d.number),
      payTo: d.payTo,
      deadline: 2_000_000_000n,
      ...change,
    },
    order: {
      supplierId: KALIBRE_ID,
      supplierName: 'Kalibre Studio',
      addressOnFile: KALIBRE.payTo,
      quote: { html: render(documentFor('q-2210', ACCOUNT)) },
    },
    invoice: format === 'html' ? { html: render(d) } : { text: asText(d) },
  };
}

describe('the checker', () => {
  it('releases a clean invoice with a signature the vault accepts', async () => {
    const model = new FakeModel('jev', allFine);
    const input = inputFor('ks-1001');
    const r = await check(input, { model, signer });
    expect(r.verdict).toBe('release');
    if (r.verdict !== 'release') return;
    const p = input.payment;
    const recovered = await recoverTypedDataAddress({
      domain: vaultDomain(p.chainId, p.vault),
      types: paymentTypes,
      primaryType: 'Payment',
      message: {
        amount: p.amount,
        invoiceHash: p.invoiceHash,
        payTo: p.payTo,
        deadline: p.deadline,
      },
      signature: r.checkerSig,
    });
    expect(recovered).toBe(signer.address);
    expect(r.evidence).toMatchObject({ model: { name: 'jev-v1' } });
  });

  it('never signs a dry run', async () => {
    const r = await check(
      { ...inputFor('ks-1001'), dryRun: true },
      {
        model: new FakeModel('jev', allFine),
        signer,
      },
    );
    expect(r).toMatchObject({ verdict: 'release', checkerSig: '0x' });
  });

  it('holds a line the order does not cover when the model says so (the padded line)', async () => {
    const model = new FakeModel('jev', (q) => (q.key === 'on_order' ? 0.05 : allFine(q)));
    const r = await check(inputFor('ks-1003'), { model, signer });
    expect(r).toMatchObject({ verdict: 'hold', reason: 'items_mismatch' });
    expect(model.asked.map((q) => q.key)).toContain('on_order');
  });

  it('asks about lines only when some are not on the quote', async () => {
    const model = new FakeModel('jev', allFine);
    await check(inputFor('ks-1001'), { model, signer });
    expect(model.asked.map((q) => q.key)).not.toContain('on_order');
  });

  it('holds instructions aimed at an automated reader in a text it cannot see hidden (text only)', async () => {
    const model = new FakeModel('jev', (q) => (q.key === 'instructions' ? 0.9 : allFine(q)));
    const r = await check(inputFor('ks-1005', {}, 'text'), { model, signer });
    expect(r).toMatchObject({ verdict: 'hold', reason: 'hidden_instructions' });
  });

  it('holds an unsure answer', async () => {
    const model = new FakeModel('jev', (q) => (q.key === 'same_supplier' ? 0.5 : allFine(q)));
    expect(await check(inputFor('ks-1001'), { model, signer })).toMatchObject({
      verdict: 'hold',
      reason: 'checker_unsure',
    });
  });

  it('D27: every code failure stays held whatever the model says, and the model is not asked', async () => {
    const cases: [CheckInput, string][] = [
      [inputFor('ks-1004'), 'amount_mismatch'],
      [inputFor('ks-1005'), 'hidden_instructions'],
      [inputFor('ks-1002', { payTo: KALIBRE.payTo }), 'address_mismatch'],
      [inputFor('ks-1001', { amount: 2_000n }), 'amount_mismatch'],
      [inputFor('ks-1001', { invoiceHash: invoiceHash(KALIBRE_ID, 'KS-9999') }), 'checker_unsure'],
      [{ ...inputFor('ks-1001'), invoice: { text: 'nothing readable' } }, 'checker_unsure'],
    ];
    for (const [input, reason] of cases) {
      const model = new FakeModel('jev', allFine);
      expect(await check(input, { model, signer })).toMatchObject({ verdict: 'hold', reason });
      expect(model.calls).toBe(0);
    }
  });

  it('holds when the model fails or runs out of time (fail closed)', async () => {
    expect(
      await check(inputFor('ks-1001'), {
        model: new FakeModel('jev', allFine, 0, true),
        signer,
      }),
    ).toMatchObject({ verdict: 'hold', reason: 'checker_unavailable' });
    const started = Date.now();
    expect(
      await check(inputFor('ks-1001'), {
        model: new FakeModel('jev', allFine, 5_000),
        signer,
        budgetMs: 200,
      }),
    ).toMatchObject({ verdict: 'hold', reason: 'checker_unavailable' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('asks the fallback when the first model fails, and says which answered', async () => {
    const model = new FallbackModel([
      new FakeModel('jev', allFine, 0, true),
      new FakeModel('sonnet', allFine),
    ]);
    const r = await check(inputFor('ks-1001'), { model, signer });
    expect(r.verdict).toBe('release');
    expect(r.evidence).toMatchObject({ model: { name: 'sonnet-v1' } });
  });

  it('records what it read and every check in the evidence', async () => {
    const r = await check(inputFor('ks-1004'), { model: new FakeModel('jev', allFine), signer });
    expect(r.evidence).toMatchObject({
      read: { number: expect.stringMatching(/^KS-1004-/) as string, total: '0.0018' },
    });
    expect(JSON.stringify(r.evidence)).toContain('the quote says 0.0001 USDC');
  });
});

describe('a hold, signed so it can be recorded on Monad (Slice 18)', () => {
  const recover = (input: CheckInput, d: SignedDecision) =>
    recoverTypedDataAddress({
      domain: vaultDomain(input.payment.chainId, input.payment.vault),
      types: decisionTypes,
      primaryType: 'Decision',
      message: {
        invoiceHash: d.invoiceHash,
        outcome: d.outcome,
        reasonHash: d.reasonHash,
        evidenceHash: d.evidenceHash,
      },
      signature: d.sig,
    });

  it('signs the vault’s Decision over the evidence it returns, whether code or the model held it', async () => {
    const byCode = inputFor('ks-1004');
    const byModel = inputFor('ks-1003');
    const worried = new FakeModel('jev', (q) => (q.key === 'on_order' ? 0.05 : allFine(q)));
    for (const [input, model] of [
      [byCode, new FakeModel('jev', allFine)],
      [byModel, worried],
    ] as const) {
      const r = await check(input, { model, signer });
      expect(r.verdict).toBe('hold');
      if (r.verdict !== 'hold' || !r.decision) throw new Error('no decision');
      expect(r.decision).toMatchObject({
        invoiceHash: input.payment.invoiceHash,
        outcome: OUTCOME.held,
        reasonHash: reasonHash(r.reason),
        // The hash is of the evidence exactly as returned, after the time is written into it.
        evidenceHash: evidenceHash(JSON.parse(JSON.stringify(r.evidence))),
      });
      expect(await recover(input, r.decision)).toBe(signer.address);
    }
  });

  it('signs no decision on a dry run, and none on a release', async () => {
    const dry = await check(
      { ...inputFor('ks-1004'), dryRun: true },
      { model: new FakeModel('jev', allFine), signer },
    );
    expect(dry.verdict === 'hold' && dry.decision).toBeFalsy();
    const ok = await check(inputFor('ks-1001'), { model: new FakeModel('jev', allFine), signer });
    expect('decision' in ok).toBe(false);
  });
});

describe('which reason a hold gives', () => {
  it('prefers a clear answer to an unsure one, and instructions over paying elsewhere', async () => {
    const unsureThenClear = new FakeModel('jev', (q) =>
      q.key === 'instructions' ? 0.5 : q.key === 'on_order' ? 0.05 : allFine(q),
    );
    expect(await check(inputFor('ks-1003'), { model: unsureThenClear, signer })).toMatchObject({
      verdict: 'hold',
      reason: 'items_mismatch',
    });
    const both = new FakeModel('jev', (q) =>
      q.key === 'instructions' || q.key === 'pays_elsewhere' ? 0.97 : allFine(q),
    );
    expect(await check(inputFor('ks-1005', {}, 'text'), { model: both, signer })).toMatchObject({
      verdict: 'hold',
      reason: 'hidden_instructions',
    });
  });
});
