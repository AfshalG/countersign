import { getAddress, type Address } from 'viem';

/**
 * Reading a document the way an agent's page reader does (Slice 8). No model: fixed patterns over
 * the page's text. The reader keeps text a person cannot see (it does not render CSS), which is
 * exactly how instructions hidden in a page reach an agent.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * An HTML page's body as text: the head (title, styles) and scripts dropped, every other element's
 * text kept, hidden or not, one block per line.
 */
export function pageText(html: string): string {
  return html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|table|tbody|thead|tfoot|main|section|span)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

export type ReadDocument = {
  kind: 'quote' | 'invoice' | 'checkout' | null;
  /** The sender, as its header names it. */
  supplier: string | null;
  number: string | null;
  /** The total in USDC, as printed ("0.0015"). */
  totalUsdc: string | null;
  /** The USDC address printed for payment. */
  payTo: Address | null;
  /** Paid by bank transfer (any USDC line is an alternative). */
  bankTransfer: boolean;
  /** The quote an invoice cites ("Q-2210"), so it is paid from the order opened from it. */
  quote: string | null;
  /** A sentence in the document telling the reader to pay another address. */
  instruction: { payTo: Address; text: string } | null;
  /** The text read, kept as the payment's or the proposal's document (what the checker reads). */
  text: string;
};

const ADDRESS = /0x[0-9a-fA-F]{40}/g;

/** The fields an agent needs from a document's text. */
export function readDocument(text: string): ReadDocument {
  const lines = text.split('\n').map((l) => l.trim());
  const title = lines.find((l) => /^(Invoice|Quote|Checkout) \S+$/.test(l)) ?? null;
  const kind = title?.startsWith('Invoice')
    ? 'invoice'
    : title?.startsWith('Quote')
      ? 'quote'
      : title?.startsWith('Checkout')
        ? 'checkout'
        : null;
  // The sender's header: "Kalibre Studio · Product photography…" (HTML) or "… — …" (text).
  const header = lines.find((l) => / [·—] /.test(l)) ?? null;
  const supplier = header?.split(/ [·—] /)[0]?.trim() ?? null;
  const total = /Total:?\s+([0-9]+(?:\.[0-9]+)?)\s*USDC/.exec(text)?.[1] ?? null;
  const printed = /pay in USDC on Monad to\s+(0x[0-9a-fA-F]{40})/i.exec(text)?.[1];
  const payTo = printed ? getAddress(printed) : null;
  const quote = /quote (Q-\d+)/i.exec(text)?.[1] ?? null;
  // Any sentence that asks for payment to an address other than the printed one.
  let instruction: ReadDocument['instruction'] = null;
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    if (!/\bpay\b/i.test(sentence)) continue;
    const other = [...sentence.matchAll(ADDRESS)]
      .map((m) => getAddress(m[0]))
      .find((a) => a !== payTo);
    if (other) {
      instruction = { payTo: other, text: sentence.trim() };
      break;
    }
  }
  return {
    kind,
    supplier,
    number: title ? (title.split(' ')[1] ?? null) : null,
    totalUsdc: total,
    payTo,
    bankTransfer: /Bank transfer/i.test(text),
    quote,
    instruction,
    text,
  };
}

/** A shop's home page: its name (the page's heading) and the payment address it publishes. */
export function readShop(html: string): { name: string; payTo: Address } | null {
  const name = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const text = pageText(html);
  const address = /Our payment address\s+(0x[0-9a-fA-F]{40})/.exec(text)?.[1];
  return name && address ? { name: pageText(name), payTo: getAddress(address) } : null;
}
