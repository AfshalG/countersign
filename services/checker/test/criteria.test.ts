import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { invoiceHash, supplierId, supplierSlug } from '@countersign/shared';
import { documentFor, KALIBRE } from '../../../apps/supplier/lib/documents';
import { render } from '../../../apps/supplier/lib/render';
import { advise } from '../src/advise.js';
import { check, questionsFor } from '../src/check.js';
import { JevModel, SonnetModel, type Model, type Question } from '../src/model.js';
import { keySigner } from '../src/sign.js';

/**
 * Each question the model answers says what counts as yes and what counts as no (TypeSafe's
 * "criteria", 9 Oct): the definitions travel with the question to whichever model answers, and the
 * evidence records them, so an auditor sees exactly what was asked.
 */
const ACCOUNT = '0x8f1431D15E547a1073b064e73F0C61372CcEA739';
const KALIBRE_ID = supplierId(supplierSlug('Kalibre Studio'));
const ORDER = {
  supplierId: KALIBRE_ID,
  supplierName: 'Kalibre Studio',
  addressOnFile: KALIBRE.payTo,
  quote: { html: render(documentFor('q-2210', ACCOUNT)) },
};

class Recorder implements Model {
  readonly name = 'recorder';
  asked: Question[] = [];
  ask(_state: unknown, questions: readonly Question[]) {
    this.asked = [...questions];
    return Promise.resolve({
      answers: Object.fromEntries(
        questions.map((q) => [
          q.key,
          q.key === 'same_supplier' || q.key === 'on_order' ? 0.95 : 0.05,
        ]),
      ),
      model: 'recorder-v1',
    });
  }
}

const defined = (q: Question) => {
  expect(q.criteria?.true, `${q.key}: what counts as yes`).toMatch(/\w{3,}/);
  expect(q.criteria?.false, `${q.key}: what counts as no`).toMatch(/\w{3,}/);
};

describe('questions with their definitions', () => {
  it('defines yes and no for every question the checker asks', () => {
    const qs = questionsFor(ORDER, ['Rush delivery'], true);
    expect(qs.map((q) => q.key)).toEqual([
      'same_supplier',
      'pays_elsewhere',
      'instructions',
      'on_order',
    ]);
    qs.forEach(defined);
    // The address the answer turns on is named in the definition of no.
    expect(qs.find((q) => q.key === 'pays_elsewhere')?.criteria?.false).toContain(KALIBRE.payTo);
  });

  it('records the definitions in the evidence the checker signs', async () => {
    const d = documentFor('ks-1001', ACCOUNT);
    const model = new Recorder();
    const r = await check(
      {
        payment: {
          chainId: 10143,
          vault: '0x6c033066C05Eb524119c8C830F937C4bbd17E426',
          amount: BigInt(Math.round(Number(d.totalUsdc) * 1e6)),
          invoiceHash: invoiceHash(KALIBRE_ID, d.number),
          payTo: d.payTo,
          deadline: 2_000_000_000n,
        },
        order: ORDER,
        invoice: { html: render(d) },
      },
      { model, signer: keySigner(generatePrivateKey()) },
    );
    expect(r.verdict).toBe('release');
    const criteria = r.evidence.model?.criteria ?? {};
    expect(Object.keys(criteria)).toEqual(model.asked.map((q) => q.key));
    for (const q of model.asked) expect(criteria[q.key]).toEqual(q.criteria);
  });

  it('defines the bank question, with an account on file and without one', async () => {
    for (const onFile of [
      { holder: KALIBRE.bank.holder, iban: KALIBRE.bank.iban, bic: KALIBRE.bank.bic },
      null,
    ]) {
      const model = new Recorder();
      const a = await advise(
        {
          order: ORDER,
          bankOnFile: onFile,
          invoice: { html: render(documentFor('ks-1008', ACCOUNT)) },
        },
        { model },
      );
      const bank = model.asked.find((q) => q.key === 'bank_elsewhere');
      expect(bank, onFile ? 'with an account on file' : 'with none').toBeDefined();
      if (bank) defined(bank);
      expect(a.evidence.model?.criteria?.bank_elsewhere).toEqual(bank?.criteria);
    }
  });
});

/** A fetch that records the request body and answers every question with `p`. */
function recordingFetch(answer: (keys: string[]) => unknown) {
  const bodies: Record<string, unknown>[] = [];
  const fn = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    bodies.push(body);
    return Promise.resolve(
      new Response(JSON.stringify(answer(Object.keys(body.questions ?? {}))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fn, bodies };
}

const QUESTION: Question = {
  key: 'pays_elsewhere',
  text: 'Does the invoice ask for payment to any other address?',
  criteria: { true: 'It names another address.', false: 'It names only the one on file.' },
};

describe('the models send the definitions', () => {
  it('Jev receives each definition as TypeSafe criteria', async () => {
    const f = recordingFetch((keys) => ({
      model: 'typesafe/jev-1.13-test',
      answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: 0.04 }])),
    }));
    const jev = new JevModel('test-key', 'typesafe/jev-1.13', f.fn);
    const r = await jev.ask('an invoice', [QUESTION], AbortSignal.timeout(1_000));
    expect(r.answers).toEqual({ pays_elsewhere: 0.04 });
    expect(f.bodies[0]?.questions).toEqual({
      pays_elsewhere: {
        type: 'noul',
        instructions: QUESTION.text,
        criteria: { true: 'It names another address.', false: 'It names only the one on file.' },
      },
    });
  });

  it('the fallback receives the same definitions in its prompt', async () => {
    const f = recordingFetch(() => ({
      model: 'anthropic/claude-sonnet-5.5',
      choices: [{ message: { content: JSON.stringify({ pays_elsewhere: 0.03 }) } }],
    }));
    const sonnet = new SonnetModel('test-key', undefined, f.fn);
    const r = await sonnet.ask('an invoice', [QUESTION], AbortSignal.timeout(1_000));
    expect(r.answers).toEqual({ pays_elsewhere: 0.03 });
    const messages = f.bodies[0]?.messages as { content: string }[];
    const user = JSON.parse(messages[1]?.content ?? '{}') as { questions: unknown };
    expect(user.questions).toEqual({
      pays_elsewhere: {
        question: QUESTION.text,
        yes: 'It names another address.',
        no: 'It names only the one on file.',
      },
    });
  });
});
