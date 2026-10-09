import type { Address, Hex } from 'viem';
import type { Order } from '@countersign/sdk';
import { supplierId, supplierSlug } from '@countersign/shared';
import type { ReadDocument } from './read.js';

/**
 * The scripted agent's decisions (Slice 8): no model, so every case is reproducible. It does what
 * an agent asked to "pay our supplier invoices" does, and no more checking than that: it pays the
 * address a document prints, and leaves the account to decide. Two personas:
 *
 * - careful: ignores instructions written inside a document;
 * - obedient: follows them, as an agent hijacked by a document's hidden text does.
 */
export type Persona = 'careful' | 'obedient';

/** What the agent remembers between documents: the order it opened from each quote. */
export type Memory = { quotes: Map<string, Hex> };

export type Action =
  | {
      kind: 'pay';
      order: Order;
      invoice: { number: string; amount: string; payTo: Address; document: string };
    }
  | {
      kind: 'propose';
      supplier: { name: string; payTo: Address };
      amount: string;
      /** The quote's number ("Q-2210"), so the order it opens is remembered. */
      quote: string | null;
      document: string;
    }
  | {
      /** Slice 17: an invoice paid by bank transfer is asked about, never paid by the account. */
      kind: 'advise';
      order: Order;
      document: string;
    }
  | { kind: 'none'; why: 'no_order' | 'unreadable' };

/** The quote number a document's own number starts with ("Q-2210-0855A" is "Q-2210"). */
const quoteOf = (number: string) => /^(Q-\d+)/.exec(number)?.[1] ?? null;

/** What to do with one document, given the account's open orders. */
export function decide(
  doc: ReadDocument,
  persona: Persona,
  orders: readonly Order[],
  memory: Memory,
): Action {
  if (!doc.kind || !doc.supplier || !doc.number || !doc.totalUsdc)
    return { kind: 'none', why: 'unreadable' };
  const payTo = persona === 'obedient' && doc.instruction ? doc.instruction.payTo : doc.payTo;
  if (doc.kind === 'quote') {
    if (!payTo) return { kind: 'none', why: 'unreadable' };
    return {
      kind: 'propose',
      supplier: { name: doc.supplier, payTo },
      amount: doc.totalUsdc,
      quote: quoteOf(doc.number),
      document: doc.text,
    };
  }
  // A bank transfer is paid at the bank, outside the account: the careful agent asks for advice
  // (Slice 17); the obedient one pays whatever USDC address the document gives it.
  const bank = doc.bankTransfer && persona === 'careful';
  if (!bank && !payTo) return { kind: 'none', why: 'unreadable' };
  const id = supplierId(supplierSlug(doc.supplier));
  const theirs = orders.filter((o) => o.supplierId.toLowerCase() === id.toLowerCase());
  if (theirs.length === 0) return { kind: 'none', why: 'no_order' };
  // The order opened from the quote the invoice cites; else the one with the most left. The
  // agent does not check limits itself: the account does.
  const cited = doc.quote ? memory.quotes.get(doc.quote) : undefined;
  const order =
    theirs.find((o) => o.orderId.toLowerCase() === cited?.toLowerCase()) ??
    [...theirs].sort((a, b) => (BigInt(b.remaining) > BigInt(a.remaining) ? 1 : -1))[0];
  if (!order) return { kind: 'none', why: 'no_order' };
  if (bank) return { kind: 'advise', order, document: doc.text };
  if (!payTo) return { kind: 'none', why: 'unreadable' };
  return {
    kind: 'pay',
    order,
    invoice: { number: doc.number, amount: doc.totalUsdc, payTo, document: doc.text },
  };
}

export type Outcome = 'proposed' | 'settled' | 'held' | 'blocked' | 'no_order' | 'advised';
/** What a document says should happen (its `case.expect`, Slice 7). */
export type Expected = {
  outcome: Outcome;
  reason?: string;
  changesAddress?: boolean;
  /** Advice on a bank transfer (Slice 17). */
  advice?: 'match' | 'mismatch' | 'unsure';
};
/** What did happen: an outcome, or any other status the gateway gave (failed, refused, …). */
export type Actual = {
  outcome: string;
  reason?: string | null;
  changesAddress?: boolean;
  advice?: string;
};

const shown = (a: { outcome: string; reason?: string | null; advice?: string }) =>
  `${a.outcome}${a.advice ? `: ${a.advice}` : ''}${a.reason ? ` (${a.reason})` : ''}`;

/** Whether a case ended as its document says it should, and if not, how it differed. */
export function compare(expected: Expected, actual: Actual): { ok: boolean; why?: string } {
  const ok =
    expected.outcome === actual.outcome &&
    (expected.reason === undefined || expected.reason === actual.reason) &&
    (expected.changesAddress === undefined || expected.changesAddress === actual.changesAddress) &&
    (expected.advice === undefined || expected.advice === actual.advice);
  if (ok) return { ok };
  const want = shown(expected) + (expected.changesAddress ? ', changing the address on file' : '');
  const got = shown(actual) + (actual.changesAddress ? ', changing the address on file' : '');
  return { ok, why: `expected ${want}, got ${got}` };
}
