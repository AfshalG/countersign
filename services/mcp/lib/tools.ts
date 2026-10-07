import { z } from 'zod';
import {
  CountersignError,
  formatUsdc,
  type Countersign,
  type Order,
  type PaymentRequest,
  type PaymentResult,
} from '@countersign/sdk';

/**
 * The six tools (Slice 12): what any MCP agent gets when it connects. Each one calls the SDK,
 * so the tools and the SDK cannot drift. Results are text written for the agent to relay to a
 * person, plus structured content. A hold always carries its reason and the link where the owner
 * decides; tools never wait on a person (Slice 4: clients cut tools off at 60 to 240 s).
 */

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 20-byte hex address');
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'a 32-byte hex id');
const amount = z
  .union([z.string(), z.number()])
  .describe('The amount in USDC as written on the invoice, e.g. "12.50"');

const invoiceInput = {
  orderId: bytes32.describe('The order to pay against, from list_open_orders'),
  invoiceNumber: z.string().min(1).max(128).describe('The invoice number as printed'),
  amount,
  payTo: address.describe('The payment address printed on the invoice'),
  invoiceText: z
    .string()
    .max(20_000)
    .optional()
    .describe('The invoice as read (text), for the checker'),
};

const orderOut = z.object({
  orderId: z.string(),
  vault: z.string(),
  addressOnFile: z.string(),
  supplierActive: z.boolean(),
  amountUsdc: z.string(),
  remainingUsdc: z.string(),
  expiresAt: z.string(),
});

const paymentOut = z.object({
  id: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  reasonText: z.string().nullable(),
  amountUsdc: z.string(),
  payTo: z.string(),
  addressOnFile: z.string().nullable(),
  txHash: z.string().nullable(),
  statusUrl: z.string(),
  duplicate: z.boolean(),
});

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const text = (t: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
});

/** A gateway or input error, said plainly; the agent should tell the person, not guess. */
function failure(e: unknown): ToolResult {
  if (e instanceof CountersignError) {
    const fields = e.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    return {
      content: [
        { type: 'text', text: `Not done (${e.code}): ${e.message}${fields ? ` (${fields})` : ''}` },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Not done: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

const amountText = (a: string | number) => (typeof a === 'number' ? String(a) : a.trim());

function onFileOf(r: PaymentRequest): string | null {
  const evidence = r.evidence as { payTo?: { onFile?: string } } | null;
  return evidence?.payTo?.onFile ?? null;
}

/** What the agent tells the person about a payment. */
export function describePayment(r: PaymentRequest): string {
  const amountUsdc = formatUsdc(BigInt(r.amount));
  switch (r.status) {
    case 'settled':
      return `Paid ${amountUsdc} USDC to the supplier's address on file (${r.payTo}). Final on Monad; transaction ${r.tx.hash ?? 'unknown'}. Details: ${r.statusUrl}`;
    case 'held': {
      const onFile = onFileOf(r);
      return [
        `Held; nothing was paid. ${r.reasonText ?? r.reason ?? ''}`.trim(),
        ...(onFile ? [`Address on file: ${onFile}`, `Address on the invoice: ${r.payTo}`] : []),
        `The owner decides here: ${r.statusUrl}`,
        'Do not retry with a different address or amount. Tell the person what was held and why.',
      ].join('\n');
    }
    case 'blocked':
    case 'refused':
    case 'expired':
    case 'failed':
      return `Not paid (${r.status}). ${r.reasonText ?? ''} Details: ${r.statusUrl}`.trim();
    default:
      return `Accepted (${r.status}); waiting for Monad to finalize. Check again with payment_status and id ${r.id}.`;
  }
}

/**
 * A resent invoice (the same supplier and number) is the earlier request, not a new payment. Said
 * first and plainly, because an agent otherwise counts it as paid twice (Slice 12 testnet run).
 */
export function describeResult(r: PaymentResult): string {
  return r.duplicate
    ? `This is the same invoice as an earlier request (same supplier and invoice number): nothing new was paid. The earlier request: ${describePayment(r)}`
    : describePayment(r);
}

function paymentStructured(r: PaymentResult) {
  return {
    duplicate: r.duplicate,
    id: r.id,
    status: r.status,
    reason: r.reason,
    reasonText: r.reasonText,
    amountUsdc: formatUsdc(BigInt(r.amount)),
    payTo: r.payTo,
    addressOnFile: onFileOf(r),
    txHash: r.tx.hash,
    statusUrl: r.statusUrl,
  };
}

function orderStructured(o: Order) {
  return {
    orderId: o.orderId,
    vault: o.vault,
    addressOnFile: o.payTo,
    supplierActive: o.supplierActive,
    amountUsdc: formatUsdc(BigInt(o.amount)),
    remainingUsdc: formatUsdc(BigInt(o.remaining)),
    expiresAt: new Date(o.expiry * 1000).toISOString(),
  };
}

type InvoiceArgs = {
  orderId: string;
  invoiceNumber: string;
  amount: string | number;
  payTo: string;
  invoiceText?: string | undefined;
};

const payInput = (a: InvoiceArgs) => ({
  order: a.orderId as `0x${string}`,
  invoice: {
    number: a.invoiceNumber,
    amount: amountText(a.amount),
    payTo: a.payTo as `0x${string}`,
    ...(a.invoiceText === undefined ? {} : { document: { text: a.invoiceText } }),
  },
});

/** The tools for one account, in hosted mode (the server holds the agent key). */
export function createTools(cs: Countersign, options: { waitMs?: number } = {}) {
  const waitMs = options.waitMs ?? 10_000;
  return {
    list_open_orders: {
      config: {
        title: 'List open orders',
        description:
          'The orders the owner approved and that are still open: each one names the only supplier address it pays and how much is left. Match an invoice to an order with this before paying.',
        inputSchema: z.object({}),
        outputSchema: z.object({ orders: z.array(orderOut) }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: async (): Promise<ToolResult> => {
        try {
          const orders = (await cs.orders()).map(orderStructured);
          const lines = orders.map(
            (o) =>
              `- ${o.orderId}: ${o.remainingUsdc} of ${o.amountUsdc} USDC left, pays only ${o.addressOnFile}, until ${o.expiresAt}`,
          );
          return text(
            orders.length === 0 ? 'No open orders.' : `Open orders:\n${lines.join('\n')}`,
            { orders },
          );
        } catch (e) {
          return failure(e);
        }
      },
    },

    check_invoice: {
      config: {
        title: 'Check an invoice',
        description:
          'Checks an invoice against its order without paying: would it be paid, held for the owner, or blocked? Use it for a dry run, or for an invoice paid by bank transfer (then it is advice only).',
        inputSchema: z.object(invoiceInput),
        outputSchema: z.object({
          verdict: z.string(),
          reason: z.string().nullable(),
          reasonText: z.string().nullable(),
          addressOnFile: z.string().nullable(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: async (args: InvoiceArgs): Promise<ToolResult> => {
        try {
          const v = await cs.check(payInput(args));
          const evidence = v.evidence as { payTo?: { onFile?: string } } | null;
          const onFile = evidence?.payTo?.onFile ?? null;
          const said =
            v.verdict === 'would_settle'
              ? 'It would be paid: the address, the order and the checker all agree. Nothing was paid.'
              : `It would be ${v.verdict}: ${v.reasonText ?? v.reason ?? ''}${onFile ? ` (address on file ${onFile}, on the invoice ${args.payTo})` : ''}. Nothing was paid.`;
          return text(said, {
            verdict: v.verdict,
            reason: v.reason,
            reasonText: v.reasonText,
            addressOnFile: onFile,
          });
        } catch (e) {
          return failure(e);
        }
      },
    },

    pay_invoice: {
      config: {
        title: 'Pay an invoice',
        description:
          'Pays an invoice against an approved order. The account pays only the supplier’s address on file, within the order; anything else is held for the owner, with a link. The same invoice twice is one payment. Returns settled, held or blocked, with the reason.',
        inputSchema: z.object(invoiceInput),
        outputSchema: paymentOut,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args: InvoiceArgs): Promise<ToolResult> => {
        try {
          const r = await cs.pay({ ...payInput(args), wait: { timeoutMs: waitMs, pollMs: 250 } });
          return text(describeResult(r), paymentStructured(r));
        } catch (e) {
          return failure(e);
        }
      },
    },

    pay_invoices: {
      config: {
        title: 'Pay a run of invoices',
        description:
          'Pays up to 100 invoices at once. Returns a run id at once; each invoice is then settled, held or blocked on its own. Check the run with payment_status.',
        inputSchema: z.object({ invoices: z.array(z.object(invoiceInput)).min(1).max(100) }),
        outputSchema: z.object({
          runId: z.string(),
          requests: z.array(z.object({ id: z.string(), status: z.string() })),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args: { invoices: InvoiceArgs[] }): Promise<ToolResult> => {
        try {
          const run = await cs.payMany(args.invoices.map(payInput));
          return text(
            `Submitted ${String(run.requests.length)} invoices as run ${run.runId}. Each is checked and settled, held or blocked on its own; check with payment_status and the run id.`,
            { runId: run.runId, requests: run.requests },
          );
        } catch (e) {
          return failure(e);
        }
      },
    },

    payment_status: {
      config: {
        title: 'Payment status',
        description: 'Looks up a payment, a run or a proposal by its id.',
        inputSchema: z.object({
          id: z.string().min(1).max(100).describe('A payment, run or proposal id'),
        }),
        outputSchema: z.object({
          kind: z.enum(['payment', 'run', 'proposal']),
          id: z.string(),
          status: z.string(),
          summary: z.string(),
          link: z.string().nullable(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: async (args: { id: string }): Promise<ToolResult> => {
        const notFound = (e: unknown) =>
          e instanceof CountersignError && e.code.startsWith('unknown_');
        try {
          const r = await cs.status(args.id);
          const summary = describePayment(r);
          return text(summary, {
            kind: 'payment',
            id: r.id,
            status: r.status,
            summary,
            link: r.statusUrl,
          });
        } catch (e) {
          if (!notFound(e)) return failure(e);
        }
        try {
          const run = await cs.run(args.id);
          const counts = Object.entries(run.byStatus)
            .filter(([, n]) => n > 0)
            .map(([s, n]) => `${String(n)} ${s}`)
            .join(', ');
          const summary = `Run of ${String(run.size)}: ${counts}.`;
          const status = run.byStatus.settled === run.size ? 'settled' : 'in progress';
          return text(summary, { kind: 'run', id: run.runId, status, summary, link: null });
        } catch (e) {
          if (!notFound(e)) return failure(e);
        }
        try {
          const p = await cs.proposal(args.id);
          const summary = `Proposal for ${p.supplierName}: ${p.status}. Review: ${p.approvalUrl}`;
          return text(summary, {
            kind: 'proposal',
            id: p.id,
            status: p.status,
            summary,
            link: p.approvalUrl,
          });
        } catch (e) {
          return failure(e);
        }
      },
    },

    propose_order: {
      config: {
        title: 'Propose a supplier and an order',
        description:
          'Proposes a supplier and an order from a quote or contract you read. Returns a link for the owner; nothing changes until they approve it with their passkey, and a new address then waits out the account’s waiting period before it can be paid.',
        inputSchema: z.object({
          supplierName: z.string().min(1).max(120),
          website: z
            .url({ protocol: /^https$/ })
            .optional()
            .describe("The supplier's own website (https)"),
          payTo: address.describe('The payment address in the quote'),
          amount: amount.describe('The order total in USDC, e.g. "4200.00"'),
          validForDays: z.number().int().min(1).max(365).default(30),
          quoteText: z.string().min(1).max(20_000).describe('The quote as read'),
        }),
        outputSchema: z.object({
          id: z.string(),
          status: z.string(),
          approvalUrl: z.string(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args: {
        supplierName: string;
        website?: string | undefined;
        payTo: string;
        amount: string | number;
        validForDays: number;
        quoteText: string;
      }): Promise<ToolResult> => {
        try {
          const p = await cs.proposeOrder({
            supplier: {
              name: args.supplierName,
              payTo: args.payTo as `0x${string}`,
              ...(args.website === undefined ? {} : { website: args.website }),
            },
            amount: amountText(args.amount),
            expiry: new Date(Date.now() + args.validForDays * 86_400_000),
            document: args.quoteText,
          });
          return text(
            `Proposed ${args.supplierName} for ${amountText(args.amount)} USDC. Nothing changes until the owner approves it with their passkey: ${p.approvalUrl}`,
            { id: p.id, status: p.status, approvalUrl: p.approvalUrl },
          );
        } catch (e) {
          return failure(e);
        }
      },
    },
  };
}
