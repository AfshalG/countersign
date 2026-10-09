/**
 * Before and after (9 Oct): the checker's model questions without and with their definitions of
 * yes and no, on the disguised invoices (scripts/disguised-invoices.ts), through the real checker
 * (or the bank advice) and the real Jev on OpenRouter. "Before" is the questions exactly as they
 * were (no definitions, the old wording of two); nothing else differs. Each invoice is asked twice
 * per arm.
 *
 * A miss is a question a careful person would stop on that the checker passed; a false alarm is
 * one they would pay that the checker held or called unsure (a person is asked for nothing).
 * Writes results/<day>-criteria-eval.json. About 130 calls, about $0.002.
 *
 *   pnpm --filter @countersign/checker criteria-eval
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import { invoiceHash, supplierId, supplierSlug } from '@countersign/shared';
import { documentFor, KALIBRE } from '../../../apps/supplier/lib/documents';
import { render } from '../../../apps/supplier/lib/render';
import { advise } from '../src/advise.js';
import { check, judge, type Evidence } from '../src/check.js';
import { JevModel, type Model, type Question } from '../src/model.js';
import { keySigner } from '../src/sign.js';
import { CASES, invoiceText, type Case, type Key, type Label } from './disguised-invoices.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('set OPENROUTER_API_KEY in the repo .env');
const jev = new JevModel(key);
const signer = keySigner(generatePrivateKey());
const ACCOUNT = '0x8f1431D15E547a1073b064e73F0C61372CcEA739';
const ORDER = {
  supplierId: supplierId(supplierSlug('Kalibre Studio')),
  supplierName: 'Kalibre Studio',
  addressOnFile: KALIBRE.payTo,
  quote: { html: render(documentFor('q-2210', ACCOUNT)) },
};
const BANK = { holder: KALIBRE.bank.holder, iban: KALIBRE.bank.iban, bic: KALIBRE.bank.bic };
const REPEATS = 2;

type Arm = 'before' | 'after';
/** The two questions whose wording changed on 9 Oct, as they were worded before. */
const AS_IT_WAS: Record<string, (q: Question) => string> = {
  pays_elsewhere: () =>
    `Does the invoice ask for payment to any address or account other than ${KALIBRE.payTo}?`,
  on_order: (q) =>
    q.text.replace(
      ", an item in the order's quote, even if described in other words?",
      ', something the order covers?',
    ),
};
/** The questions exactly as they were: the old wording, no definitions. */
function asTheyWere(q: Question): Question {
  const was = AS_IT_WAS[q.key];
  const text = was ? was(q) : q.text;
  // A wording that failed to change back would make "before" the new questions without notice.
  if (was && text === q.text) throw new Error(`could not restore the old wording of ${q.key}`);
  return { key: q.key, text };
}
/** The same model, asked the questions as they are now (after) or as they were (before). */
const armOf = (arm: Arm): Model => ({
  name: jev.name,
  ask: (state, questions, signal) =>
    jev.ask(state, arm === 'after' ? questions : questions.map(asTheyWere), signal),
});

type Outcome = 'clear' | 'flag' | 'unsure';
type Run = {
  verdict: string;
  decidedBy: string;
  answers: Record<string, number> | null;
  outcomes: Record<string, Outcome>;
  error?: string;
};

async function runOnce(c: Case, index: number, arm: Arm): Promise<Run> {
  const number = `KS-${String(2001 + index)}`;
  const { text, totalMicro } = invoiceText(c, number);
  const model = armOf(arm);
  let verdict: string;
  let evidence: Evidence;
  if (c.path === 'usdc') {
    const r = await check(
      {
        payment: {
          chainId: 10143,
          vault: '0x6c033066C05Eb524119c8C830F937C4bbd17E426',
          amount: BigInt(totalMicro),
          invoiceHash: invoiceHash(ORDER.supplierId, number),
          payTo: KALIBRE.payTo,
          deadline: 2_000_000_000n,
        },
        order: ORDER,
        invoice: { text },
        dryRun: true,
      },
      { model, signer },
    );
    verdict = r.verdict === 'hold' ? `hold ${r.reason}` : 'release';
    evidence = r.evidence;
  } else {
    const a = await advise({ order: ORDER, bankOnFile: BANK, invoice: { text } }, { model });
    verdict = a.advice === 'match' ? 'match' : `${a.advice} ${a.reason ?? ''}`.trim();
    evidence = a.evidence;
  }
  const failed = evidence.findings.find((f) => !f.ok);
  const answers = evidence.model?.answers ?? null;
  const outcomes: Record<string, Outcome> = {};
  for (const [k, p] of Object.entries(answers ?? {})) {
    const reason = judge(k, p);
    outcomes[k] = reason === null ? 'clear' : reason === 'checker_unsure' ? 'unsure' : 'flag';
  }
  return {
    verdict,
    decidedBy: failed ? `code: ${failed.check}` : answers ? 'model' : 'error',
    answers,
    outcomes,
    ...(evidence.error ? { error: evidence.error } : {}),
  };
}

/** One run, asked again if the model did not answer in time (a timeout says nothing of the wording). */
async function run(c: Case, index: number, arm: Arm): Promise<Run> {
  let r = await runOnce(c, index, arm);
  for (let i = 0; i < 2 && r.decidedBy === 'error'; i++) r = await runOnce(c, index, arm);
  return r;
}

type Cell = {
  case: string;
  key: string;
  expected: Label;
  outcome: Outcome;
  p: number;
  widened: boolean;
};
const rows: { id: string; about: string; expect: Case['expect']; before: Run[]; after: Run[] }[] =
  [];
const cells: Record<Arm, Cell[]> = { before: [], after: [] };

for (const [index, c] of CASES.entries()) {
  const row = {
    id: c.id,
    about: c.about,
    expect: c.expect,
    before: [] as Run[],
    after: [] as Run[],
  };
  for (let rep = 0; rep < REPEATS; rep++) {
    const [b, a] = await Promise.all([run(c, index, 'before'), run(c, index, 'after')]);
    row.before.push(b);
    row.after.push(a);
    for (const [arm, r] of [
      ['before', b],
      ['after', a],
    ] as const)
      for (const [k, outcome] of Object.entries(r.outcomes))
        cells[arm].push({
          case: c.id,
          key: k,
          expected: c.expect[k as Key] ?? 'clear',
          outcome,
          p: r.answers?.[k] ?? NaN,
          widened: c.widened === true,
        });
  }
  rows.push(row);
  const show = (runs: Run[]) =>
    runs[0]?.answers
      ? Object.entries(runs[0].answers)
          .map(([k, p]) => `${k.slice(0, 6)}=${p.toFixed(2)}`)
          .join(' ')
      : (runs[0]?.decidedBy ?? '');
  console.log(
    `${c.id} ${c.about.padEnd(36).slice(0, 36)} before: ${(row.before[0]?.verdict ?? '').padEnd(28)} ${show(row.before)}`,
  );
  console.log(
    `${' '.repeat(40)} after:  ${(row.after[0]?.verdict ?? '').padEnd(28)} ${show(row.after)}`,
  );
}

function summarize(list: Cell[]) {
  const scored = list.filter((x) => x.expected !== 'any');
  const shouldFlag = scored.filter((x) => x.expected === 'flag');
  const shouldClear = scored.filter((x) => x.expected === 'clear');
  return {
    answers: scored.length,
    shouldFlag: shouldFlag.length,
    missed: shouldFlag.filter((x) => x.outcome === 'clear').length,
    caughtSure: shouldFlag.filter((x) => x.outcome === 'flag').length,
    caughtUnsure: shouldFlag.filter((x) => x.outcome === 'unsure').length,
    shouldClear: shouldClear.length,
    falseAlarms: shouldClear.filter((x) => x.outcome !== 'clear').length,
    falseAlarmsSure: shouldClear.filter((x) => x.outcome === 'flag').length,
    misses: shouldFlag
      .filter((x) => x.outcome === 'clear')
      .map((x) => `${x.case}:${x.key} ${x.p.toFixed(2)}`),
    alarms: shouldClear
      .filter((x) => x.outcome !== 'clear')
      .map((x) => `${x.case}:${x.key} ${x.p.toFixed(2)}`),
  };
}
/** Did the two asks of one invoice give the same outcome on every question? */
const stable = (arm: Arm) =>
  rows.filter((r) => JSON.stringify(r[arm][0]?.outcomes) === JSON.stringify(r[arm][1]?.outcomes))
    .length;

const summary = Object.fromEntries(
  (['before', 'after'] as const).map((arm) => [
    arm,
    {
      all: summarize(cells[arm]),
      withoutWidened: summarize(cells[arm].filter((x) => !x.widened)),
      stableInvoices: `${String(stable(arm))} of ${String(rows.length)}`,
      decidedByCode: rows.filter((r) => r[arm][0]?.decidedBy.startsWith('code')).map((r) => r.id),
    },
  ]),
);
console.log(JSON.stringify(summary, null, 2));

const day = new Date().toISOString().slice(0, 10);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(
  new URL(`../results/${day}-criteria-eval.json`, import.meta.url),
  `${JSON.stringify({ at: new Date().toISOString(), model: 'typesafe/jev-1.13', repeats: REPEATS, summary, rows }, null, 2)}\n`,
);
console.log(`results/${day}-criteria-eval.json`);
