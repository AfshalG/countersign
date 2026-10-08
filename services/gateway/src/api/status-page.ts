import { chain as monad } from '@countersign/chain';
import { formatUsdc, REASON_TEXT } from '@countersign/shared';
import type { PaymentRequestRow, ProposalRow } from '../db/schema.js';
import type { RunSummary } from '../runs.js';

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
  .gap { display: inline-block; width: .35em; }
  .lead { font-size: 1.15rem; margin: .25rem 0 0; }
  details { margin-top: 1.5rem; } summary { cursor: pointer; }
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

/** Groups of four, so a long address can be read and compared; the characters stay contiguous. */
function grouped(html: string): string {
  // `html` is escaped text with <mark> tags; group by visible characters.
  const parts = html.split(/(<mark>.<\/mark>|&[a-z#0-9]+;|.)/).filter((p) => p !== '');
  let out = '';
  parts.forEach((p, i) => {
    out += i > 0 && i % 4 === 2 ? `<span class="gap"></span>${p}` : p;
  });
  return out;
}

const when = (d: Date | null) =>
  d === null
    ? null
    : `${d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC`;
const seconds = (a: Date | null, b: Date | null) =>
  a && b ? `${((b.getTime() - a.getTime()) / 1000).toFixed(1)} s` : null;

const DECIDED_BY: Record<string, string> = {
  checker: 'Countersign’s check',
  rule: 'the account’s rules on Monad',
  user_once: 'the owner, with their passkey',
  user_refused: 'the owner, with their passkey',
};

/**
 * A payment as a receipt a person reads (Afshal, 7 Oct: "receipts are not in hexa"): the amount,
 * who it is for by name, what happened and when, a link to the explorer. Two addresses are shown
 * in full only when they differ (shortening hides what an attacker changes), grouped in fours with
 * the difference marked; every other id and hash is under "Technical details".
 */
export function paymentPage(
  r: PaymentRequestRow,
  context: {
    agent?: { address: string; agentId: string | null } | null;
    supplierName?: string | null;
  } = {},
): string {
  const headline = HEADLINE[r.status] ?? r.status;
  const reason = r.reason ? REASON_TEXT[r.reason] : undefined;
  const evidence = (r.evidence ?? {}) as { payTo?: { onFile?: string; invoice?: string } };
  const onFile = evidence.payTo?.onFile;
  const invoice = evidence.payTo?.invoice ?? r.payTo;
  const explorer = monad.blockExplorers.default.url;
  const supplier = context.supplierName ?? 'the supplier';
  const usdc = `${escape(formatUsdc(BigInt(r.amount)))} USDC`;
  const agent = context.agent;
  const paid = r.status === 'settled';
  const lead = paid ? `${usdc} paid to ${escape(supplier)}` : `${usdc} for ${escape(supplier)}`;
  const timeline = [
    ['Received', when(r.requestedAt)],
    ['Checked', when(r.checkedAt)],
    [
      r.status === 'refused' ? 'Refused' : 'Decided',
      r.decidedAt && r.decidedBy?.startsWith('user') ? when(r.decidedAt) : null,
    ],
    [
      'Final on Monad',
      r.finalizedAt
        ? `${when(r.finalizedAt) ?? ''}${seconds(r.sentAt, r.finalizedAt) ? `, ${seconds(r.sentAt, r.finalizedAt) ?? ''} after sending` : ''}`
        : null,
    ],
  ]
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${escape(k ?? '')} ${escape(v ?? '')}`)
    .join('<br>');
  const rows = [
    reason ? row('Why', escape(reason)) : '',
    onFile && onFile.toLowerCase() !== invoice.toLowerCase()
      ? row(
          `${supplier}’s address on file (the only one this order pays)`,
          `<code>${grouped(marked(onFile, invoice))}</code>`,
        ) + row('The address on the invoice', `<code>${grouped(marked(invoice, onFile))}</code>`)
      : row(
          paid ? 'Paid to' : 'To',
          `${escape(supplier)}’s address on file <code>${escape(`${r.payTo.slice(0, 6)}…${r.payTo.slice(-4)}`)}</code>`,
        ),
    r.decidedBy && DECIDED_BY[r.decidedBy]
      ? row('Decided by', escape(DECIDED_BY[r.decidedBy] ?? ''))
      : '',
    agent
      ? row(
          paid ? 'Paid by agent' : 'Sent by agent',
          agent.agentId === null
            ? 'An agent not registered on ERC-8004'
            : `#${escape(agent.agentId)}, registered in Monad’s ERC-8004 agent registry`,
        )
      : '',
    timeline ? row('When', timeline) : '',
    r.txHash
      ? row(
          'On Monad',
          `<a href="${escape(`${explorer}/tx/${r.txHash}`)}" rel="noreferrer">View on the Monad explorer</a>`,
        )
      : '',
    row('Reference', `<code>${escape(r.id.slice(2, 10).toUpperCase())}</code>`),
  ].join('');
  const note =
    r.status === 'held'
      ? `<p class="note">Nothing has been paid. The owner decides with their passkey: pay once, or refuse.</p>`
      : '';
  const technical = [
    ['Request', r.id],
    ['Order vault', r.vault],
    ['Pay-to address', r.payTo],
    ['Invoice hash', r.invoiceHash],
    ...(r.txHash ? [['Transaction', r.txHash]] : []),
    ...(agent ? [['Agent wallet', agent.address]] : []),
  ]
    .map(([k, v]) => row(k ?? '', `<code>${escape(v ?? '')}</code>`))
    .join('');
  return page(
    headline,
    `<p class="muted">Countersign · Monad testnet</p><h1>${escape(headline)}</h1><p class="lead">${lead}</p><dl>${rows}</dl>${note}<details><summary class="muted">Technical details</summary><dl>${technical}</dl></details>`,
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

/**
 * A run's page (Slice 16): how far the run is, how long it has taken, and the holds grouped by
 * reason (D18), each linked to its approval page. It reloads itself until every payment is decided.
 */
export function runPage(s: RunSummary, publicUrl: string): string {
  const seconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);
  const groups = (title: string, list: RunSummary['held']) =>
    list.length === 0
      ? ''
      : `<h2>${escape(title)}</h2>${list
          .map(
            (g) =>
              `<details><summary><strong>${String(g.count)}</strong> · ${escape(g.text)}</summary><ul>${g.ids
                .map(
                  (id) =>
                    `<li><a href="${escape(`${publicUrl}/p/${id}`)}"><code>${escape(id.slice(0, 18))}…</code></a></li>`,
                )
                .join('')}</ul></details>`,
          )
          .join('')}`;
  const heldCount = s.held.reduce((n, g) => n + g.count, 0);
  const blockedCount = s.blocked.reduce((n, g) => n + g.count, 0);
  return page(
    `Run of ${String(s.size)}`,
    `<p class="muted">A payment run</p>
     <h1>${String(s.size)} invoices</h1>
     <p class="lead">${s.done ? `All decided in ${seconds(s.elapsedMs)}` : `${String(s.decided)} of ${String(s.size)} decided, ${seconds(s.elapsedMs)} so far`}</p>
     <dl>${grouped(
       row(
         'Paid and final',
         `${String(s.settled.count)} · each in ${seconds(s.settled.p50Ms)} (median), ${seconds(s.settled.p95Ms)} (95th percentile)`,
       ) +
         row('Held for the owner', String(heldCount)) +
         row('Stopped', String(blockedCount)) +
         row('Submitted', escape(s.submittedAt)),
     )}</dl>
     ${groups('Held, by reason', s.held)}
     ${groups('Stopped, by reason', s.blocked)}
     ${s.done ? '' : '<script>setTimeout(() => location.reload(), 2000)</script>'}`,
  );
}
