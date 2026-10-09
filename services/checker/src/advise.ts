import type { Reason } from '@countersign/shared';
import { compareBank, describeFile, verdictOf, type BankOnFile, type ReadBank } from './bank.js';
import { ASKED, judge, questionsFor, type Evidence, CHECKER } from './check.js';
import { codeChecks } from './compare.js';
import type { Model, Question } from './model.js';
import { readInvoice } from './read.js';
import type { OrderFacts } from './types.js';
import { formatUsdc } from '@countersign/shared';

/**
 * Advice on an invoice paid by bank transfer (Slice 17). A bank transfer happens inside the bank,
 * so nothing outside it can stop one: the checker reads the invoice itself, runs the same code
 * checks as for a USDC payment (those that need no payment), compares its bank account with the
 * one the owner put on file, and asks the model the same fixed questions with a bank question in
 * place of the USDC one. The answer is advice: match, mismatch or unsure. It never signs.
 *
 * As for a payment (D27), code decides first; the model is asked only when code found nothing
 * definite, and can add a concern but never remove one. Anything unsure is unsure, never a match.
 */

export type AdviseInput = {
  order: OrderFacts;
  /** The supplier's bank account as the owner approved it; null when there is none on file. */
  bankOnFile: BankOnFile | null;
  invoice: { html?: string; text?: string };
};

export type AdviceEvidence = Evidence & {
  read: Evidence['read'] & { bank: ReadBank };
  /** The account on file, as the advice describes it. */
  onFile: string | null;
};

export type AdviceOutcome = {
  advice: 'match' | 'mismatch' | 'unsure';
  reason?: Reason;
  evidence: AdviceEvidence;
};

/** Advice is not on a payment's path: the model gets longer than a check's 1.5 s. */
export const ADVICE_BUDGET_MS = 5_000;

function bankQuestion(onFile: BankOnFile | null): Question {
  return {
    key: 'bank_elsewhere',
    text: onFile
      ? `Does the invoice ask for payment to any bank account other than ${describeFile(onFile)}, or say the supplier's bank details have changed?`
      : "Does the invoice say the supplier's bank details have changed, or ask for payment to a new account?",
  };
}

export async function advise(
  input: AdviseInput,
  deps: { model: Model; budgetMs?: number },
): Promise<AdviceOutcome> {
  const started = Date.now();
  const invoice = readInvoice(input.invoice);
  const code = codeChecks(invoice, null, input.order);
  const bank = compareBank(invoice.bank, input.bankOnFile);
  const findings = [...code.findings, ...bank.findings];
  const evidence: AdviceEvidence = {
    checker: CHECKER,
    read: {
      source: invoice.source,
      number: invoice.number,
      sender: invoice.sender,
      total: invoice.total === null ? null : formatUsdc(invoice.total),
      payTo: invoice.payTo,
      lines: invoice.lines.map(
        (l) =>
          `${l.description} x${String(l.quantity)} at ${formatUsdc(l.unit)}: ${formatUsdc(l.amount)}`,
      ),
      hiddenText: invoice.hiddenText,
      bank: invoice.bank,
    },
    onFile: input.bankOnFile ? describeFile(input.bankOnFile) : null,
    findings,
    ms: 0,
  };
  const done = (o: Omit<AdviceOutcome, 'evidence'>): AdviceOutcome => {
    evidence.ms = Date.now() - started;
    return { ...o, evidence };
  };

  const fromCode = verdictOf(findings);
  // A definite finding in code is the advice; the model is not asked (D27).
  if (fromCode.advice === 'mismatch') return done(fromCode);

  const questions = questionsFor(
    input.order,
    code.unmatched.map((l) => l.description),
    code.quote !== null && code.quote.lines.length > 0,
  ).map((q) => (q.key === 'pays_elsewhere' ? bankQuestion(input.bankOnFile) : q));
  const state = {
    invoice: invoice.machineText,
    order: {
      supplier: input.order.supplierName,
      addressOnFile: input.order.addressOnFile,
      bankOnFile: evidence.onFile,
      quote: code.quote?.machineText ?? null,
    },
  };
  const asked = Date.now();
  let answer;
  try {
    answer = await deps.model.ask(
      state,
      questions,
      AbortSignal.timeout(deps.budgetMs ?? ADVICE_BUDGET_MS),
    );
  } catch (e) {
    evidence.error = e instanceof Error ? e.message : String(e);
    // Code's own doubt explains more than a model that did not answer.
    return done(
      fromCode.advice === 'unsure' ? fromCode : { advice: 'unsure', reason: 'checker_unavailable' },
    );
  }
  evidence.model = {
    name: answer.model,
    answers: answer.answers,
    questions: Object.fromEntries(questions.map((q) => [q.key, q.text])),
    ms: Date.now() - asked,
  };
  const concerns = questions
    .map((q) => {
      const p = answer.answers[q.key];
      return { key: q.key, reason: typeof p === 'number' ? judge(q.key, p) : 'checker_unsure' };
    })
    .filter((c): c is { key: string; reason: Reason } => c.reason !== null)
    .sort(
      (a, b) =>
        Number(a.reason === 'checker_unsure') - Number(b.reason === 'checker_unsure') ||
        (ASKED[a.key]?.rank ?? 9) - (ASKED[b.key]?.rank ?? 9),
    );
  const first = concerns[0];
  if (first && first.reason !== 'checker_unsure')
    return done({ advice: 'mismatch', reason: first.reason });
  if (fromCode.advice === 'unsure') return done(fromCode);
  if (first) return done({ advice: 'unsure', reason: 'checker_unsure' });
  return done({ advice: 'match' });
}
