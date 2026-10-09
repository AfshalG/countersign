import { getAddress, type Address } from 'viem';
import { usdc } from '@countersign/shared';
import { readBank, type ReadBank } from './bank.js';
import {
  invisibleIn,
  lookAlikesIn,
  smuggledText,
  withoutInvisible,
  type Invisible,
} from './invisible.js';

/**
 * The checker's own read of an invoice (Slice 10). It never takes the agent's word for a field:
 * it reads the document the agent was given. Printed fields come from what a person sees; text
 * only a machine reads (hidden by CSS) is kept apart, because that is how instructions aimed at
 * an agent hide (the hijack). Fixed patterns, no model: reading numbers is code's job (D27).
 *
 * Hidden text is found by the element's inline style (display, visibility, a font size of 1px or
 * less, near-zero opacity, transparent colour, pushed far off the page, clipped, scaled to nothing,
 * no height with overflow hidden), the `hidden` attribute, and HTML comments; characters with no
 * width, that reverse reading order or that spell text invisibly (tag characters) are listed apart
 * (9 Oct). Limits: a page styled from a stylesheet, or white text on a white background, needs a
 * real renderer (with PDF, later). A field it cannot find is null, never guessed.
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
  /** Bank details, from the text a person sees (Slice 17: advice for bank transfers). */
  bank: ReadBank;
  /** Everything a machine reads: what the model is asked about. */
  machineText: string;
  /** Text present in the page that a person would not see. */
  hiddenText: string[];
  /** Characters a person cannot see (zero width, reversed reading order, tag characters). */
  invisible: Invisible[];
  /** Letters from another alphabet mixed into the number or the sender ("U+039A GREEK …"). */
  lookAlikes: string[];
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

/** Inline styles that hide text from a person while a machine still reads it. */
const STYLE_HIDES = [
  'display\\s*:\\s*none',
  'visibility\\s*:\\s*hidden',
  'font-size\\s*:\\s*0(?![.\\d]*[1-9])',
  'font-size\\s*:\\s*(?:0?\\.\\d+|1)px',
  'opacity\\s*:\\s*0(?:\\.0\\d*)?(?![.\\d]*[1-9])',
  'color\\s*:\\s*transparent',
  '(?:left|top|right|text-indent|margin-left|margin-top)\\s*:\\s*-\\d{3,}(?:\\.\\d+)?(?:px|em|rem)',
  'clip-path\\s*:\\s*inset\\(\\s*(?:50|100)%',
  'clip\\s*:\\s*rect\\(\\s*0',
  'transform\\s*:\\s*scale\\(\\s*0(?![.\\d]*[1-9])',
  '(?:max-)?(?:height|width)\\s*:\\s*0(?:px)?\\s*(?=;|")[^"]*overflow\\s*:\\s*hidden',
  'overflow\\s*:\\s*hidden[^"]*(?:max-)?(?:height|width)\\s*:\\s*0(?:px)?\\s*(?=;|")',
];
const HIDDEN = new RegExp(
  `<(\\w+)\\b[^>]*\\bstyle\\s*=\\s*"[^"]*(?:${STYLE_HIDES.join('|')})[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`,
  'gi',
);
/** An element with the `hidden` attribute (not aria-hidden, which does not hide). */
const HIDDEN_ATTR = /<(\w+)\b[^>]*\shidden(?=[\s=>])[^>]*>([\s\S]*?)<\/\1>/gi;
/** An HTML comment with words in it. */
const COMMENT = /<!--([\s\S]*?)-->/g;

/**
 * One invoice line however it is written: our pages' cells ("desc | 10 | 0.0001 USDC | 0.001
 * USDC"), our text ("desc x10 at 0.0001 USDC: 0.001 USDC"), a markdown table, or cells run
 * together as an agent's page reader leaves them ("desc 10 0.0001 USDC 0.001 USDC"). Table pipes
 * are dropped first; then a description, a whole quantity, a unit price and an amount.
 */
const LINE =
  /^(.+?)\s+x?(\d+)\s+(?:at\s+)?([0-9]+(?:\.[0-9]+)?)\s*USDC:?\s+([0-9]+(?:\.[0-9]+)?)\s*USDC$/;
const unpiped = (l: string) =>
  l
    .replace(/^\|\s*|\s*\|$/g, '')
    .replace(/\s*\|\s*/g, '  ')
    .replace(/\s+/g, ' ')
    .trim();

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
    const m = LINE.exec(unpiped(l));
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
  const total = text
    .split('\n')
    .map((l) => /^Total\b[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*USDC$/.exec(unpiped(l))?.[1])
    .find((t) => t !== undefined);
  const payTo = /pay in USDC on Monad to\s+(0x[0-9a-fA-F]{40})/i.exec(text)?.[1];
  return {
    kind: title ? (title[1]?.toLowerCase() as 'invoice' | 'quote' | 'checkout') : null,
    number: title?.[2] ?? null,
    sender: header?.split(/ [·—] /)[0]?.trim() ?? null,
    lines: items,
    total: total ? amountOf(total) : null,
    payTo: payTo ? getAddress(payTo) : null,
    bank: readBank(text),
  };
}

/** Reads an invoice, a quote or a checkout from its HTML or its text. */
export function readInvoice(doc: { html?: string; text?: string }): ReadInvoice {
  const raw = doc.html ?? doc.text ?? '';
  // Characters a person cannot see are listed, then taken out so the fields around them read.
  const invisible = invisibleIn(raw);
  const smuggled = smuggledText(raw);
  const clean = withoutInvisible(raw);
  const withLookAlikes = (r: ReturnType<typeof fields>) => ({
    ...r,
    invisible,
    lookAlikes: [...new Set([...lookAlikesIn(r.number ?? ''), ...lookAlikesIn(r.sender ?? '')])],
  });
  if (doc.html !== undefined) {
    const body = clean
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    const comments = [...body.matchAll(COMMENT)]
      .map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim())
      .filter((t) => /\p{L}{2,}/u.test(t));
    const hiddenText = [
      ...[...body.matchAll(HIDDEN), ...body.matchAll(HIDDEN_ATTR)]
        .map((m) => textOf(m[2] ?? '').replace(/\n/g, ' '))
        .filter((t) => t !== ''),
      ...comments,
      ...smuggled,
    ];
    const visible = textOf(body.replace(COMMENT, '').replace(HIDDEN, '').replace(HIDDEN_ATTR, ''));
    return {
      ...withLookAlikes(fields(visible)),
      // What a model is asked about: everything a machine reads, the hidden parts included.
      machineText: [textOf(body), ...comments, ...smuggled].join('\n'),
      hiddenText,
      source: 'html',
    };
  }
  return {
    ...withLookAlikes(fields(clean)),
    machineText: [clean, ...smuggled].join('\n'),
    hiddenText: smuggled,
    source: 'text',
  };
}
