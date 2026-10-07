import { chain as monad } from '@countersign/chain';
import { formatUsdc, REASON_TEXT } from '@countersign/shared';
import type { PaymentRequestRow, ProposalRow } from '../db/schema.js';

/**
 * A plain, read-only page a person can open from an agent's message (Slice 12, S12-7): what
 * happened to a payment or a proposal, in plain words. It is the approval link until the
 * approver app (Slices 9 and 11) replaces it. Phone-first, no scripts, no external resources;
 * everything an agent or a document supplied is escaped. It shows nothing that is not already
 * public on chain or in the agent's own message (D24): payees, amounts, statuses.
 */

const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** The address with the characters that differ from `other` marked, so a look-alike stands out. */
function marked(address: string, other: string): string {
  let out = '';
  for (let i = 0; i < address.length; i++) {
    const ch = address.charAt(i);
    out +=
      ch.toLowerCase() === other.charAt(i).toLowerCase()
        ? escape(ch)
        : `<mark>${escape(ch)}</mark>`;
  }
  return out;
}

export const HEADLINE: Record<string, string> = {
  requested: 'Received, not checked yet',
  checking: 'Being checked',
  held: 'Held for the owner',
  released: 'Released, being sent',
  settling: 'Sent, waiting for Monad to finalize',
  settled: 'Paid',
  blocked: 'Blocked',
  refused: 'Refused by the owner',
  expired: 'Expired before a decision',
  failed: 'Failed; no money moved',
};

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} · Countersign</title>
<style>
  :root { color-scheme: light dark; --fg: #1e1838; --muted: #5b556e; --bg: #fbfaff; --line: #dcd8ec; --mark: #fde68a; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ecebf5; --muted: #a9a4bd; --bg: #14121c; --line: #34304a; --mark: #92400e; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .muted { color: var(--muted); }
  dl { margin: 1.25rem 0; border-top: 1px solid var(--line); }
  dt { color: var(--muted); font-size: .85rem; margin-top: .75rem; }
  dd { margin: .1rem 0 0; overflow-wrap: anywhere; }
  code { font: .95rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  mark { background: var(--mark); color: inherit; }
  .note { border-left: 3px solid var(--line); padding: .25rem 0 .25rem .75rem; margin-top: 1.25rem; }
  a { color: inherit; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function row(label: string, value: string): string {
  return `<dt>${escape(label)}</dt><dd>${value}</dd>`;
}

export function paymentPage(r: PaymentRequestRow): string {
  const headline = HEADLINE[r.status] ?? r.status;
  const reason = r.reason ? REASON_TEXT[r.reason] : undefined;
  const evidence = (r.evidence ?? {}) as { payTo?: { onFile?: string; invoice?: string } };
  const onFile = evidence.payTo?.onFile;
  const invoice = evidence.payTo?.invoice ?? r.payTo;
  const explorer = monad.blockExplorers.default.url;
  const rows = [
    row('Amount', `${escape(formatUsdc(BigInt(r.amount)))} USDC`),
    onFile
      ? row(
          'Address on file (the only one this order pays)',
          `<code>${marked(onFile, invoice)}</code>`,
        ) + row('Address on the invoice', `<code>${marked(invoice, onFile)}</code>`)
      : row('Pay to', `<code>${escape(r.payTo)}</code>`),
    reason ? row('Why', escape(reason)) : '',
    r.txHash
      ? row(
          'Transaction',
          `<a href="${escape(`${explorer}/tx/${r.txHash}`)}" rel="noreferrer"><code>${escape(r.txHash)}</code></a>`,
        )
      : '',
    row('Request', `<code>${escape(r.id)}</code>`),
  ].join('');
  const note =
    r.status === 'held'
      ? `<p class="note">Nothing has been paid. The owner decides with their passkey; the approver app that does this arrives in a later build. Until then this page shows the decision once it is made.</p>`
      : '';
  return page(
    headline,
    `<p class="muted">Countersign · Monad testnet</p><h1>${escape(headline)}</h1><dl>${rows}</dl>${note}`,
  );
}

export function proposalPage(p: ProposalRow): string {
  const headline =
    p.status === 'pending' ? 'A proposed supplier and order' : `Proposal ${p.status}`;
  const rows = [
    row('Supplier', escape(p.supplierName)),
    p.website
      ? row('Website', `<a href="${escape(p.website)}" rel="noreferrer">${escape(p.website)}</a>`)
      : '',
    row('Payment address (as read from the quote)', `<code>${escape(p.payTo)}</code>`),
    row('Order amount', `${escape(formatUsdc(BigInt(p.amount)))} USDC`),
    row('Until', escape(new Date(p.expiry * 1000).toUTCString())),
    row('Proposal', `<code>${escape(p.id)}</code>`),
  ].join('');
  return page(
    headline,
    `<p class="muted">Countersign · Monad testnet</p><h1>${escape(headline)}</h1><dl>${rows}</dl><p class="note">Nothing changes until the owner signs with their passkey. A new payment address also waits out the account's waiting period before it can be paid.</p>`,
  );
}
