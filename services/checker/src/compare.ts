import type { Reason } from '@countersign/shared';
import { formatUsdc, invoiceHash, supplierId, supplierSlug } from '@countersign/shared';
import { readInvoice, type InvoiceLine, type ReadInvoice } from './read.js';
import type { Finding, OrderFacts, PaymentFacts } from './types.js';

/**
 * The code checks (Slice 10): exact comparisons of the invoice the checker read with the payment
 * and the order the owner approved. They alone decide "clear" (D27); the model is asked only when
 * they pass, and can only add a hold. Every check runs, so the evidence is complete; the first
 * that fails gives the reason.
 */
export type CodeResult = {
  findings: Finding[];
  hold: Reason | null;
  /** Invoice lines with no line of the same description on the quote: the model judges them (with a quote). */
  unmatched: InvoiceLine[];
  quote: ReadInvoice | null;
};

const same = (a: string, b: string) =>
  a.toLowerCase().replace(/\s+/g, ' ').trim() === b.toLowerCase().replace(/\s+/g, ' ').trim();
const usd = (units: bigint) => `${formatUsdc(units)} USDC`;

export function codeChecks(
  invoice: ReadInvoice,
  payment: PaymentFacts,
  order: OrderFacts,
): CodeResult {
  const findings: Finding[] = [];
  const add = (check: string, ok: boolean, detail: string, reason: Reason) =>
    findings.push(ok ? { check, ok, detail } : { check, ok, detail, reason });

  // 1. Read: without these, nothing else can be compared.
  const missing = [
    invoice.number === null && 'number',
    invoice.sender === null && 'sender',
    invoice.total === null && 'total',
    invoice.payTo === null && 'payment address',
    invoice.lines.length === 0 && 'lines',
  ].filter((m): m is string => m !== false);
  add(
    'read',
    missing.length === 0,
    missing.length === 0 ? 'every field read' : `could not read: ${missing.join(', ')}`,
    'checker_unsure',
  );

  // 2. Text a person cannot see: how instructions aimed at an agent hide.
  add(
    'hidden_text',
    invoice.hiddenText.length === 0,
    invoice.hiddenText.length === 0
      ? 'nothing hidden from a person'
      : `text a person cannot see: "${invoice.hiddenText.join(' ').slice(0, 300)}"`,
    'hidden_instructions',
  );

  if (invoice.number !== null) {
    // 3. The payment is for this document: its invoice hash is the order's supplier and this number.
    const ok = invoiceHash(order.supplierId, invoice.number) === payment.invoiceHash;
    add(
      'identity',
      ok,
      ok
        ? `the payment is for invoice ${invoice.number}`
        : `the payment is not for invoice ${invoice.number}`,
      'checker_unsure',
    );
  }
  if (invoice.sender !== null) {
    // 4. The sender is the order's supplier.
    // A name with no letters or digits has no slug, so it cannot be the order's supplier.
    const id = /[\p{L}\p{N}]/u.test(invoice.sender)
      ? supplierId(supplierSlug(invoice.sender))
      : null;
    const ok = id === order.supplierId;
    add(
      'supplier',
      ok,
      ok
        ? `from the order's supplier (${invoice.sender})`
        : `from ${invoice.sender}, not the order's supplier${order.supplierName ? ` (${order.supplierName})` : ''}`,
      'supplier_mismatch',
    );
  }
  if (invoice.payTo !== null) {
    // 5. The payment goes where the invoice says (the contract keeps it to the address on file).
    const ok = invoice.payTo === payment.payTo;
    add(
      'address',
      ok,
      ok
        ? `pays the printed address ${invoice.payTo}`
        : `the invoice prints ${invoice.payTo}; the payment goes to ${payment.payTo}`,
      'address_mismatch',
    );
  }
  if (invoice.total !== null && invoice.lines.length > 0) {
    // 6. The lines add up, line by line and to the total.
    const sum = invoice.lines.reduce((s, l) => s + l.amount, 0n);
    const bad = invoice.lines.find((l) => l.unit * BigInt(l.quantity) !== l.amount);
    const ok = sum === invoice.total && bad === undefined;
    add(
      'arithmetic',
      ok,
      ok
        ? 'the lines add up to the total'
        : bad
          ? `"${bad.description}": ${String(bad.quantity)} at ${usd(bad.unit)} is not ${usd(bad.amount)}`
          : `the lines add up to ${usd(sum)}, not the total ${usd(invoice.total)}`,
      'amount_mismatch',
    );
  }
  if (invoice.total !== null) {
    // 7. The payment's amount is the invoice's total.
    const ok = invoice.total === payment.amount;
    add(
      'amount',
      ok,
      ok
        ? `pays the total, ${usd(invoice.total)}`
        : `the total is ${usd(invoice.total)}; the payment is ${usd(payment.amount)}`,
      'amount_mismatch',
    );
  }

  // 8. Prices against the quote the owner approved: no line dearer than quoted.
  const quote = order.quote ? readInvoice(order.quote) : null;
  const unmatched: InvoiceLine[] = [];
  if (quote && quote.lines.length > 0) {
    for (const l of invoice.lines) {
      const q = quote.lines.find((x) => same(x.description, l.description));
      if (!q) {
        unmatched.push(l);
        continue;
      }
      const ok = l.unit <= q.unit;
      add(
        'price',
        ok,
        ok
          ? `"${l.description}" at ${usd(l.unit)}, as quoted`
          : `"${l.description}" at ${usd(l.unit)}; the quote says ${usd(q.unit)}`,
        'amount_mismatch',
      );
    }
  } else {
    unmatched.push(...invoice.lines);
    findings.push({
      check: 'price',
      ok: true,
      detail:
        'no quote on file for this order: its lines are not compared with one; the order and the contract bound the amount',
    });
  }

  const failed = findings.find((f) => !f.ok);
  return { findings, hold: failed?.reason ?? null, unmatched, quote };
}
