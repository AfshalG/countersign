import { CASES, FIELDSTONE, KALIBRE, type DemoDocument } from './documents';

/**
 * Plain pages for the demo documents (Slice 7): server-rendered HTML a person and an agent can
 * both read, the same as text and as JSON. Kept plain on purpose; Sophie restyles them.
 */

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --bg: #fff; --tint: #f5f5f7; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; --bg: #111; --tint: #1c1c1e; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
  h1 { font-size: 1.5rem; margin: .25rem 0 1rem; } h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  .muted { color: var(--muted); } .small { font-size: .875rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; } td, th { text-align: left; padding: .5rem .25rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  code { font: .9rem ui-monospace, monospace; overflow-wrap: anywhere; }
  .box { background: var(--tint); border-radius: .75rem; padding: 1rem; margin: 1rem 0; }
  .note { border-left: 3px solid var(--muted); padding-left: .75rem; }
  a { color: inherit; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

const amount = (usdc: string) => `${usdc} USDC`;

/**
 * One document as its sender would publish it. It never says what is wrong with it: an agent
 * reading it (Slice 14's real agents) must find that out, or not. The /demo index and the JSON
 * say what each case tests.
 */
export function render(d: DemoDocument): string {
  const rows = d.lines
    .map(
      (l) =>
        `<tr><td>${escape(l.description)}</td><td class="n">${String(l.quantity)}</td><td class="n">${amount(l.unitUsdc)}</td><td class="n">${amount(l.totalUsdc)}</td></tr>`,
    )
    .join('');
  const pay = d.bank
    ? `<div class="box"><strong>Bank transfer</strong><br>${escape(d.bank.name)}<br>IBAN <code>${escape(d.bank.iban)}</code><br>BIC <code>${escape(d.bank.bic)}</code></div><p class="small muted">Or pay in USDC on Monad to <code>${escape(d.payTo)}</code></p>`
    : `<div class="box"><strong>Pay in USDC on Monad to</strong><br><code>${escape(d.payTo)}</code></div>`;
  const hidden = d.hidden
    ? // Invisible to a person, present for anything that reads the page's text: how real ones hide.
      `<div style="display:none" aria-hidden="true">${escape(d.hidden)}</div><span style="font-size:0">${escape(d.hidden)}</span>`
    : '';
  return page(
    `${d.title} · ${d.from.name}`,
    `<p class="muted small">${escape(d.from.name)} · ${escape(d.from.tagline)}</p>
     <h1>${escape(d.title)}</h1>
     <p class="small">Issued ${escape(d.issued)}${d.due ? ` · Due ${escape(d.due)}` : ''}${d.reference ? `<br>Reference: ${escape(d.reference)}` : ''}</p>
     <table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody>
     <tfoot><tr><th>Total</th><th></th><th></th><th class="n">${amount(d.totalUsdc)}</th></tr></tfoot></table>
     ${d.notes.map((n) => `<p class="note">${escape(n)}</p>`).join('')}
     ${pay}${hidden}
     <p class="small muted">Questions: ${escape(d.from.email)} · Testnet amounts.</p>`,
  );
}

/** The document as an agent's page reader extracts it: every word, hidden ones included. */
export function asText(d: DemoDocument): string {
  return [
    `${d.from.name} — ${d.from.tagline}`,
    d.title,
    `Issued ${d.issued}${d.due ? `, due ${d.due}` : ''}`,
    d.reference ? `Reference: ${d.reference}` : '',
    ...d.lines.map(
      (l) =>
        `${l.description} x${String(l.quantity)} at ${amount(l.unitUsdc)}: ${amount(l.totalUsdc)}`,
    ),
    `Total: ${amount(d.totalUsdc)}`,
    ...d.notes,
    d.bank ? `Bank transfer: ${d.bank.name}, IBAN ${d.bank.iban}, BIC ${d.bank.bic}` : '',
    `Pay in USDC on Monad to ${d.payTo}`,
    d.hidden ?? '',
    `Questions: ${d.from.email}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** The index of every case: what it is, where it is, what Countersign does. */
export function demoIndex(account: string | undefined): string {
  const q = account ? `?account=${encodeURIComponent(account)}` : '';
  const path = (id: string) =>
    id.startsWith('q-')
      ? `/quotes/${id}`
      : id.startsWith('fs-')
        ? `/shop/${id}`
        : `/invoices/${id}`;
  const rows = CASES.map(
    (c) =>
      `<tr><td><a href="${path(c.id)}${q}">${escape(c.label)}</a><br><span class="small muted">${escape(c.wrong)}</span></td><td class="small">${escape(c.today)}${'after' in c ? `<br><span class="muted">${escape(c.after)}</span>` : ''}</td></tr>`,
  ).join('');
  return page(
    'Demo documents · Countersign',
    `<p class="muted small">Countersign demo · Monad testnet</p><h1>Demo documents</h1>
     <p>Quotes, invoices and a checkout, clean and doctored, published by two suppliers and a shop. Give one to an agent and watch what Countersign does with its payment.${account ? ` These are for account <code>${escape(account)}</code>.` : ' Add <code>?account=0x…</code> for your own judge-mode account.'}</p>
     <table><thead><tr><th>Document</th><th>What Countersign does</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

export function kalibreHome(): string {
  return page(
    KALIBRE.name,
    `<p class="muted small">${escape(KALIBRE.tagline)}</p><h1>${escape(KALIBRE.name)}</h1>
     <p>We photograph products for online shops. We are paid in USDC on Monad.</p>
     <div class="box"><strong>Our payment address</strong><br><code>${escape(KALIBRE.payTo)}</code><br>
     <span class="small muted">Published at <a href="/.well-known/countersign.json">/.well-known/countersign.json</a>. If an invoice asks you to pay anywhere else, it is not from us.</span></div>
     <p class="small">Demo supplier for Countersign: <a href="/demo">the demo documents</a> · <a href="/shop">Fieldstone Supply, a demo shop</a></p>`,
  );
}

export function shopHome(account: string | undefined): string {
  const q = account ? `?account=${encodeURIComponent(account)}` : '';
  return page(
    FIELDSTONE.name,
    `<p class="muted small">${escape(FIELDSTONE.tagline)}</p><h1>${escape(FIELDSTONE.name)}</h1>
     <p>Light stands, backdrops and studio supplies. Checkout in USDC on Monad.</p>
     <div class="box"><strong>Our payment address</strong><br><code>${escape(FIELDSTONE.payTo)}</code><br><span class="small muted">To buy from us through Countersign, approve us as a supplier first: propose an order at this address.</span></div>
     <p><a href="/shop/fs-checkout${q}">Checkout: light stands, 0.001 USDC</a></p>
     <p class="small muted"><a href="/demo${q}">All demo documents</a></p>`,
  );
}
