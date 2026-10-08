import { randomBytes } from 'node:crypto';
import { getAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { Countersign, type Invoice } from '@countersign/sdk';

/**
 * Demo invoices for a judge's account (Slice 9 part 4): the hosted demo agent pays one, through
 * the gateway's public API exactly as any agent does, so the judge sees a payment settle, or held
 * and decided with their own Face ID.
 */

export const DEMO_INVOICE_KINDS = ['clean', 'changed_address', 'amount_mismatch'] as const;
export type DemoInvoiceKind = (typeof DEMO_INVOICE_KINDS)[number];

/** 0.001 USDC: under the 0.002 cap a new supplier address has for its first week (Slice 5). */
export const DEMO_INVOICE_AMOUNT = '0.001';

const HEADER = 'Kalibre Studio — Product photography for online shops';
const PHOTOS = 'Product photos, white background';

/**
 * The quote a judge's demo order is opened on (Slice 10): its hash is the order's `orderHash`, so
 * the checker compares each demo invoice with the quote the judge's passkey approved. Written in
 * the same text form as the supplier site's documents (`?format=text`).
 */
export const DEMO_QUOTE = [
  HEADER,
  'Quote Q-2210',
  'Issued 7 October 2026',
  `${PHOTOS} x50 at 0.0001 USDC: 0.005 USDC`,
  'Total: 0.005 USDC',
  'Valid for 30 days. Paid in USDC on Monad to the address below, which our website also lists.',
  'Pay in USDC on Monad to 0x90f9931B748B26763161a8191C178Fe425C25fEc',
  'Questions: billing@kalibre.example',
].join('\n');

/**
 * A look-alike of an address, made the way address poisoning makes them: the same first six and
 * last four characters, which is all most people check. Nobody holds a key for it, and the vault
 * would refuse it anyway (it pays only the address on file).
 */
export function lookAlike(address: Address): Address {
  const lower = address.toLowerCase();
  const middle = keccak256(stringToHex(`look-alike of ${lower}`)).slice(2, 32);
  return getAddress(`${lower.slice(0, 8)}${middle}${lower.slice(-4)}`);
}

/**
 * One demo invoice from Kalibre Studio, numbered uniquely so it is never taken for a resent one,
 * as text the checker reads (Slice 10): ten photos at the quote's price; the amount demo bills
 * them at 0.00012, above the quote, which the checker holds.
 */
export function demoInvoice(kind: DemoInvoiceKind, addressOnFile: Address): Invoice {
  const number = `KS-DEMO-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const payTo = kind === 'changed_address' ? lookAlike(addressOnFile) : addressOnFile;
  const [unit, amount] =
    kind === 'amount_mismatch' ? ['0.00012', '0.0012'] : ['0.0001', DEMO_INVOICE_AMOUNT];
  const text = [
    HEADER,
    `Invoice ${number}`,
    'Issued 7 October 2026, due 21 October 2026',
    'Reference: Kalibre Studio quote Q-2210: 50 product photos',
    `${PHOTOS} x10 at ${unit} USDC: ${amount} USDC`,
    `Total: ${amount} USDC`,
    ...(kind === 'changed_address'
      ? ['We have changed our payment details: please pay our new address below.']
      : []),
    `Pay in USDC on Monad to ${payTo}`,
    'Questions: billing@kalibre.example',
  ].join('\n');
  return { number, amount, payTo, document: { text } };
}

export type DemoPayment = {
  id: Hex;
  status: string;
  reason: string | null;
  reasonText: string | null;
  txHash: Hex | null;
};

/**
 * Pays a demo invoice from an account's open order: 'no_open_order' when nothing is left, and
 * 'not_indexed' when `orderId` (the account's demo order) is not in the gateway's index yet.
 */
export interface DemoAgent {
  pay(
    account: Address,
    invoice: Invoice,
    orderId?: Hex,
  ): Promise<DemoPayment | 'no_open_order' | 'not_indexed'>;
}

/**
 * How long the agent waits for an order set up a moment ago: the index follows Monad's finalized
 * blocks, so a judge who asks for an invoice right after setup would otherwise be told the order
 * is used up (seen live, 7 Oct). Judge mode's indexing took up to 8.9 s after a fresh start.
 */
const INDEX_WAIT_MS = 15_000;

/**
 * The hosted demo agent: our own SDK with the demo agent's key, calling this gateway's API
 * in-process (`app.request`) with the service token, exactly as an outside agent would over HTTP.
 */
export function sdkAgent(options: {
  request: (input: Request | string, init?: RequestInit) => Response | Promise<Response>;
  token: string;
  agentKey: Hex;
  chainId: number;
  indexWaitMs?: number;
}): DemoAgent {
  return {
    async pay(account, invoice, orderId) {
      const cs = new Countersign({
        gateway: 'http://gateway.internal',
        token: options.token,
        account,
        agentKey: options.agentKey,
        chainId: options.chainId,
        fetch: (input, init) =>
          Promise.resolve(options.request(input instanceof Request ? input : String(input), init)),
      });
      const until = Date.now() + (options.indexWaitMs ?? INDEX_WAIT_MS);
      let orders = await cs.orders();
      const ours = () => orders.find((o) => o.orderId.toLowerCase() === orderId?.toLowerCase());
      while (orderId !== undefined && !ours()) {
        if (Date.now() >= until) return 'not_indexed';
        await new Promise((r) => setTimeout(r, 500));
        orders = await cs.orders();
      }
      const order = ours() ?? orders.find((o) => BigInt(o.remaining) >= 1_000n);
      if (!order || BigInt(order.remaining) < 1_000n) return 'no_open_order';
      const r = await cs.pay({ order, invoice, wait: { timeoutMs: 15_000, pollMs: 300 } });
      return {
        id: r.id,
        status: r.status,
        reason: r.reason,
        reasonText: r.reasonText,
        txHash: r.tx.hash,
      };
    },
  };
}
