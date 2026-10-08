import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { REASONS, type Reason } from '@countersign/shared';
import type { Chain } from './chain/types.js';
import type { CheckInput, CheckResult, Checker } from './checker.js';
import type { PaymentRequestRow } from './db/schema.js';
import type { Store } from './db/store.js';
import { DEMO_QUOTE } from './demo/invoices.js';

/**
 * The real checker, seen from the gateway (Slice 10): a separate service with its own key, asked
 * over HTTP (`POST /v1/check`, the spec in docs/developers/checker-spec.md). The gateway never
 * signs a release itself; it sends what it knows and verifies nothing it cannot: the contract
 * checks the checker's signature, and the pipeline simulates the payment with it before release.
 */

/** What the gateway knows of the order: from its index, the chain and the approved proposal. */
export type OrderFacts = {
  supplierId: Hex;
  supplierName: string | null;
  addressOnFile: Address;
  quote: { text: string } | null;
};

const DEMO_QUOTE_HASH = keccak256(stringToHex(DEMO_QUOTE));

/**
 * The order a payment is against, as the checker needs it. The quote is the document the owner
 * approved: an approved proposal's (its hash is the order's `orderHash`), or judge mode's demo
 * quote. An order opened without one (a label for a hash) has no quote, and the checker says so.
 */
export async function orderFacts(
  deps: {
    store: Pick<Store, 'orderByVault' | 'approvedQuote'>;
    chain: Pick<Chain, 'addressOnFile'>;
  },
  row: PaymentRequestRow,
): Promise<OrderFacts | null> {
  const order = await deps.store.orderByVault(row.vault);
  if (!order) return null;
  const [addressOnFile, approved] = await Promise.all([
    deps.chain.addressOnFile(row.account as Address, row.vault as Address),
    deps.store.approvedQuote(row.account, order.orderHash),
  ]);
  const quote =
    typeof approved?.document === 'string'
      ? { text: approved.document }
      : order.orderHash.toLowerCase() === DEMO_QUOTE_HASH
        ? { text: DEMO_QUOTE }
        : null;
  return {
    supplierId: order.supplierId as Hex,
    supplierName: approved?.supplierName ?? (quote?.text === DEMO_QUOTE ? 'Kalibre Studio' : null),
    addressOnFile,
    quote,
  };
}

/** The invoice as the agent passed it: a page, its text, or nothing the checker can read. */
function pageOf(document: unknown): { html: string } | { text: string } {
  if (typeof document === 'string') return { text: document };
  if (typeof document === 'object' && document !== null) {
    const d = document as { html?: unknown; text?: unknown };
    if (typeof d.html === 'string') return { html: d.html };
    if (typeof d.text === 'string') return { text: d.text };
  }
  return { text: '' };
}

export class RemoteChecker implements Checker {
  constructor(
    private readonly options: {
      url: string;
      token: string;
      facts: (row: PaymentRequestRow) => Promise<OrderFacts | null>;
      fetchFn?: typeof fetch;
    },
  ) {}

  async check(input: CheckInput, signal: AbortSignal): Promise<CheckResult> {
    const facts = await this.options.facts(input.request);
    if (!facts)
      return {
        verdict: 'hold',
        reason: 'checker_unsure',
        evidence: { checker: 'remote', error: 'the order is not in the gateway’s index yet' },
      };
    const res = await (this.options.fetchFn ?? fetch)(`${this.options.url}/v1/check`, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        payment: {
          chainId: input.chainId,
          vault: input.request.vault,
          amount: input.payment.amount.toString(),
          invoiceHash: input.payment.invoiceHash,
          payTo: input.payment.payTo,
          deadline: Number(input.payment.deadline),
        },
        order: facts,
        invoice: pageOf(input.request.document),
        ...(input.dryRun === true ? { dryRun: true } : {}),
      }),
    });
    if (!res.ok) throw new Error(`the checker answered ${String(res.status)}`);
    const out = (await res.json()) as {
      verdict?: unknown;
      reason?: unknown;
      checkerSig?: unknown;
      evidence?: unknown;
    };
    const evidence = out.evidence ?? null;
    // Trust only a well-formed answer: anything else is a hold (money rule 1).
    if (out.verdict === 'release') {
      const sig = out.checkerSig;
      const ok =
        typeof sig === 'string' &&
        (input.dryRun === true ? sig === '0x' : /^0x[0-9a-fA-F]{130}$/.test(sig));
      return ok
        ? { verdict: 'release', checkerSig: sig as Hex, evidence }
        : { verdict: 'hold', reason: 'checker_unsure', evidence };
    }
    const reason = (REASONS as readonly unknown[]).includes(out.reason)
      ? (out.reason as Reason)
      : 'checker_unsure';
    return { verdict: 'hold', reason, evidence };
  }
}
