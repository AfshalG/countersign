import { getAddress, type Address } from 'viem';
import { usdc } from '@countersign/shared';

/**
 * The checker's own read of an invoice (Slice 10). It never takes the agent's word for a field:
 * it reads the document the agent was given. Printed fields come from what a person sees; text
 * only a machine reads (hidden by CSS) is kept apart, because that is how instructions aimed at
 * an agent hide (the hijack). Fixed patterns, no model: reading numbers is code's job (D27).
 *
 * Limits: hidden elements are found by their inline style (display, visibility, font size,
 * opacity), which is how the demo documents and most injected text hide; a page styled from a
 * stylesheet needs a real renderer (with PDF, later). A field it cannot find is null, never guessed.
 */

export type InvoiceLine = {
  description: string;
  quantity: number;
  /** USDC base units. */
  unit: bigint;
  amount: bigint;
};

export type ReadInvoice = {
  kind: 'invoice' | 'quote' | 'checkout' | null;
  number: string | null;
  /** The sender, as its header names it. */
  sender: string | null;
  lines: InvoiceLine[];
  total: bigint | null;
  /** The USDC address printed for payment, from the text a person sees. */
  payTo: Address | null;
  /** Everything a machine reads: what the model is asked about. */
  machineText: string;
  /** Text present in the page that a person would not see. */
  hiddenText: string[];
  source: 'html' | 'text';
};

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** HTML to text: cells separated by " | ", one block per line. */
function textOf(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/(p|div|h[1-6]|tr|li|table|thead|tbody|tfoot|main|section|span)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '' && l !== '|')
    .join('\n');
}

const HIDDEN =
  /<(\w+)\b[^>]*\bstyle\s*=\s*"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d]*[1-9])|opacity\s*:\s*0(?![.\d]*[1-9]))[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;

const TEXT_LINE = /^(.+) x(\d+) at ([0-9.]+) USDC: ([0-9.]+) USDC$/;
const TABLE_LINE = /^(.+?) \| (\d+) \| ([0-9.]+) USDC \| ([0-9.]+) USDC \|?$/;

function amountOf(s: string): bigint | null {
  try {
    return usdc(s);
  } catch {
    return null;
  }
}

function fields(text: string) {
  const lines = text.split('\n');
  const title = lines.map((l) => /^(Invoice|Quote|Checkout) (\S+)$/.exec(l)).find((m) => m);
  const header = lines.find((l) => / [·—] /.test(l));
  const items: InvoiceLine[] = [];
  for (const l of lines) {
    const m = TEXT_LINE.exec(l) ?? TABLE_LINE.exec(l);
    if (!m) continue;
    const [, description, quantity, unit, amount] = m;
    const u = amountOf(unit ?? '');
    const a = amountOf(amount ?? '');
    if (description && quantity && u !== null && a !== null)
      items.push({
        description: description.trim(),
        quantity: Number(quantity),
        unit: u,
        amount: a,
      });
  }
  const total = /^Total\b[^0-9]*([0-9.]+) USDC\s*\|?$/m.exec(text)?.[1];
  const payTo = /pay in USDC on Monad to\s+(0x[0-9a-fA-F]{40})/i.exec(text)?.[1];
  return {
    kind: title ? (title[1]?.toLowerCase() as 'invoice' | 'quote' | 'checkout') : null,
    number: title?.[2] ?? null,
    sender: header?.split(/ [·—] /)[0]?.trim() ?? null,
    lines: items,
    total: total ? amountOf(total) : null,
    payTo: payTo ? getAddress(payTo) : null,
  };
}

/** Reads an invoice, a quote or a checkout from its HTML or its text. */
export function readInvoice(doc: { html?: string; text?: string }): ReadInvoice {
  if (doc.html !== undefined) {
    const body = doc.html
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    const hiddenText = [...body.matchAll(HIDDEN)]
      .map((m) => textOf(m[2] ?? '').replace(/\n/g, ' '))
      .filter((t) => t !== '');
    const visible = textOf(body.replace(HIDDEN, ''));
    return {
      ...fields(visible),
      machineText: textOf(body),
      hiddenText,
      source: 'html',
    };
  }
  const text = doc.text ?? '';
  return { ...fields(text), machineText: text, hiddenText: [], source: 'text' };
}
