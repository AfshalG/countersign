import { compactIban, ibanValid, routingValid, spacedIban, type Reason } from '@countersign/shared';
import type { Finding } from './types.js';

/**
 * Bank details on an invoice, for advice (Slice 17). A bank transfer happens inside the bank, so
 * nothing outside it can stop one: the checker reads the account the invoice asks to be paid to,
 * compares it with the account the owner put on file, and answers match, mismatch or unsure. The
 * headline case is the oldest fraud in accounts payable: "we have moved to a new bank".
 *
 * Fixed patterns, no model (D27): an IBAN (labelled, or unlabelled if its check digits hold), a
 * BIC or SWIFT code, a UK sort code, a US routing number, account numbers and the account holder.
 * A field it cannot find is left out, never guessed; anything it cannot be sure of is "unsure",
 * never a match.
 */

/** The supplier's bank account, as the owner approved it. */
export type BankOnFile = {
  holder: string;
  iban?: string;
  bic?: string;
  sortCode?: string;
  accountNumber?: string;
  routingNumber?: string;
};

export type ReadBank = {
  holder: string | null;
  ibans: { value: string; valid: boolean }[];
  bics: string[];
  sortCodes: string[];
  routingNumbers: { value: string; valid: boolean }[];
  accountNumbers: string[];
};

export type BankAdvice = {
  advice: 'match' | 'mismatch' | 'unsure';
  reason?: Reason;
  findings: Finding[];
};

const compact = compactIban;

export { ibanValid };
export const spaced = spacedIban;

/** Words that end an IBAN printed on one line with other fields. */
const LABEL = /^(BIC|SWIFT|SORT|ACCOUNT|ACCT|ROUTING|ABA|REF|REFERENCE|BANK)$/i;

/** The IBAN after one "IBAN" label: the longest run of groups whose check digits hold. */
function labelledIban(rest: string): { value: string; valid: boolean } | null {
  const tokens: string[] = [];
  // Up to the end of its field: a comma, a semicolon, a table cell or the line's end.
  for (const t of rest
    .replace(/[,;|\n][\s\S]*$/, '')
    .trim()
    .split(/\s+/)) {
    if (!/^[A-Z0-9]+$/i.test(t) || LABEL.test(t)) break;
    tokens.push(t.toUpperCase());
  }
  let longest: string | null = null;
  for (let n = tokens.length; n > 0; n--) {
    const candidate = tokens.slice(0, n).join('');
    if (candidate.length < 15 || candidate.length > 34) continue;
    if (!/^[A-Z]{2}[0-9]{2}/.test(candidate)) continue;
    if (ibanValid(candidate)) return { value: candidate, valid: true };
    longest ??= candidate;
  }
  return longest === null ? null : { value: longest, valid: false };
}

function holderOf(text: string): string | null {
  const labelled =
    /(?:account\s*(?:name|holder)|beneficiary(?:\s*name)?|payee(?:\s*name)?)\s*:?\s*([^,;|\n]+)/i.exec(
      text,
    )?.[1];
  if (labelled) return labelled.trim();
  // "Bank transfer: Kalibre Studio Ltd, IBAN …" (as text), or a "Bank transfer" heading with the
  // holder on the next line (the demo site's page).
  const inline = /bank transfer:\s*([^,;|\n]+),\s*(?:IBAN|sort|account|routing)/i.exec(text)?.[1];
  if (inline) return inline.trim();
  const lines = text.split('\n').map((l) => l.trim());
  const i = lines.findIndex((l) => /^bank transfer:?$/i.test(l));
  const next = i >= 0 ? lines[i + 1] : undefined;
  return next && !/^(IBAN|BIC|SWIFT|sort|account|routing)\b/i.test(next) ? next : null;
}

/** The bank details in the text a person sees. */
export function readBank(text: string): ReadBank {
  const ibans = new Map<string, boolean>();
  for (const m of text.matchAll(/\bIBAN\b\s*:?\s*/gi)) {
    const found = labelledIban(text.slice(m.index + m[0].length));
    if (found) ibans.set(found.value, found.valid);
  }
  // Unlabelled, compact or in groups of four: only if its check digits hold (anything else that
  // looks like one is too likely to be a reference number).
  for (const m of text.matchAll(
    /\b[A-Z]{2}[0-9]{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)\b/g,
  )) {
    const value = compact(m[0]);
    if (!ibans.has(value) && ibanValid(value)) ibans.set(value, true);
  }
  const bics = [
    ...new Set(
      [...text.matchAll(/\b(?:BIC|SWIFT)(?:\s*(?:\/\s*BIC|code))?\s*:?\s*([A-Za-z0-9]{8,11})\b/gi)]
        .map((m) => m[1] ?? '')
        .filter((b) => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(b)),
    ),
  ];
  const sortCodes = [
    ...new Set(
      [...text.matchAll(/\bsort\s*code\s*:?\s*(\d{2})[-\s]?(\d{2})[-\s]?(\d{2})\b/gi)].map(
        (m) => `${m[1] ?? ''}${m[2] ?? ''}${m[3] ?? ''}`,
      ),
    ),
  ];
  const routingNumbers = [
    ...new Set(
      [...text.matchAll(/\b(?:routing|ABA)(?:\s*(?:number|no\.?|#))?\s*:?\s*(\d{9})\b/gi)].map(
        (m) => m[1] ?? '',
      ),
    ),
  ].map((value) => ({ value, valid: routingValid(value) }));
  const accountNumbers = [
    ...new Set(
      [
        ...text.matchAll(
          /\b(?:account|acct\.?)\s*(?:number|no\.?|#)?\s*:?\s*(\d[\d -]{4,22}\d)\b/gi,
        ),
      ]
        .map((m) => (m[1] ?? '').replace(/\D/g, ''))
        .filter((a) => a.length >= 6 && a.length <= 17),
    ),
  ];
  return {
    holder: holderOf(text),
    ibans: [...ibans].map(([value, valid]) => ({ value, valid })),
    bics,
    sortCodes,
    routingNumbers,
    accountNumbers,
  };
}

/** Every way the same account can be written: a UK IBAN holds its sort code and account number. */
function keysOf(a: {
  iban?: string;
  sortCode?: string;
  routingNumber?: string;
  accountNumber?: string;
}) {
  const keys = new Set<string>();
  if (a.iban) {
    const iban = compact(a.iban);
    keys.add(`iban:${iban}`);
    if (iban.startsWith('GB') && iban.length === 22) {
      keys.add(`uk:${iban.slice(8, 14)}:${iban.slice(14)}`);
      keys.add(`acct:${iban.slice(14)}`);
    }
  }
  const acct = a.accountNumber?.replace(/\D/g, '');
  if (acct) {
    keys.add(`acct:${acct}`);
    if (a.sortCode) keys.add(`uk:${a.sortCode.replace(/\D/g, '')}:${acct}`);
    if (a.routingNumber) keys.add(`us:${a.routingNumber}:${acct}`);
  }
  return keys;
}

export const describeFile = (f: BankOnFile) =>
  f.iban
    ? `IBAN ${spaced(compact(f.iban))}`
    : f.sortCode
      ? `sort code ${f.sortCode}, account ${f.accountNumber ?? '?'}`
      : f.routingNumber
        ? `routing ${f.routingNumber}, account ${f.accountNumber ?? '?'}`
        : `account ${f.accountNumber ?? '?'}`;

/** A holder's name without punctuation or the company's legal form, to compare names fairly. */
const holderName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\b(ltd|limited|inc|incorporated|llc|plc|gmbh|co|company|corp|corporation)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The advice: a different account (or bank) is a mismatch; anything the checker cannot be sure of
 * is unsure; a match needs an account read and every account read to be the one on file.
 */
export function compareBank(read: ReadBank, onFile: BankOnFile | null): BankAdvice {
  const findings: Finding[] = [];
  const add = (check: string, ok: boolean, detail: string, reason: Reason) =>
    findings.push(ok ? { check, ok, detail } : { check, ok, detail, reason });

  if (onFile === null) {
    add(
      'bank_on_file',
      false,
      "no bank account on file for this supplier: the owner adds one, and the invoice's is compared with it",
      'checker_unsure',
    );
    return { advice: 'unsure', reason: 'checker_unsure', findings };
  }
  const known = keysOf(onFile);

  // Each account the invoice gives, in the form it gives it.
  const accounts: { shown: string; keys: Set<string> }[] = read.ibans
    .filter((i) => i.valid)
    .map((i) => ({ shown: `IBAN ${spaced(i.value)}`, keys: keysOf({ iban: i.value }) }));
  const numbers = [...read.accountNumbers];
  for (const sortCode of read.sortCodes) {
    const accountNumber = numbers.shift();
    if (accountNumber)
      accounts.push({
        shown: `sort code ${sortCode}, account ${accountNumber}`,
        keys: new Set([`uk:${sortCode}:${accountNumber}`]),
      });
  }
  for (const r of read.routingNumbers.filter((x) => x.valid)) {
    const accountNumber = numbers.shift();
    if (accountNumber)
      accounts.push({
        shown: `routing ${r.value}, account ${accountNumber}`,
        keys: new Set([`us:${r.value}:${accountNumber}`]),
      });
  }
  // An account number on its own, unless it is the one inside an IBAN already read.
  const inIbans = new Set(accounts.flatMap((a) => [...a.keys]));
  for (const n of numbers)
    if (!inIbans.has(`acct:${n}`))
      accounts.push({ shown: `account ${n}`, keys: new Set([`acct:${n}`]) });

  const badDigits = [
    ...read.ibans.filter((i) => !i.valid).map((i) => `IBAN ${spaced(i.value)}`),
    ...read.routingNumbers.filter((r) => !r.valid).map((r) => `routing number ${r.value}`),
  ];
  if (badDigits.length > 0)
    add(
      'bank_check_digits',
      false,
      `${badDigits.join(', ')}: the check digits do not add up (a misprint, or a misread)`,
      'checker_unsure',
    );

  if (accounts.length === 0 && badDigits.length === 0)
    add('bank_read', false, 'no bank account could be read on the invoice', 'checker_unsure');

  for (const a of accounts) {
    const ok = [...a.keys].some((k) => known.has(k));
    add(
      'bank_account',
      ok,
      ok
        ? `pays the account on file (${a.shown})`
        : `the invoice gives ${a.shown}; the account on file is ${describeFile(onFile)}`,
      'bank_account_mismatch',
    );
  }

  // The bank's code: its first eight characters name the bank, country and location.
  if (onFile.bic)
    for (const bic of read.bics) {
      const ok = bic.slice(0, 8) === compact(onFile.bic).slice(0, 8);
      add(
        'bank_code',
        ok,
        ok
          ? `the bank on file (${bic})`
          : `the invoice names bank ${bic}; the bank on file is ${onFile.bic}`,
        'bank_account_mismatch',
      );
    }

  if (read.holder !== null) {
    const ok = holderName(read.holder) === holderName(onFile.holder);
    add(
      'bank_holder',
      ok,
      ok
        ? `in the name on file (${onFile.holder})`
        : `the account is in the name "${read.holder}"; the name on file is "${onFile.holder}"`,
      'checker_unsure',
    );
  }

  return { ...verdictOf(findings), findings };
}

/** Any finding with a definite reason is a mismatch; one the checker cannot be sure of, unsure. */
export function verdictOf(findings: Finding[]): Omit<BankAdvice, 'findings'> {
  const failed = findings.filter((f) => !f.ok);
  const definite = failed.find(
    (f) =>
      f.reason !== undefined && f.reason !== 'checker_unsure' && f.reason !== 'checker_unavailable',
  );
  if (definite?.reason) return { advice: 'mismatch', reason: definite.reason };
  const unsure = failed[0];
  if (unsure) return { advice: 'unsure', reason: unsure.reason ?? 'checker_unsure' };
  return { advice: 'match' };
}
