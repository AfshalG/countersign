import { z } from 'zod';

/** Where a held payment is approved. The spike points at the Slice 1 passkey page. */
export const APPROVAL_PAGE = 'https://countersign-passkey-spike.vercel.app/';

/** Demo suppliers. Kalibre Studio's address matches its proof in Spike 2. */
export const KNOWN_SUPPLIERS = [
  {
    name: 'Kalibre Studio',
    payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEc',
    orderLimit: 5_000,
  },
] as const;

export const checkPaymentInput = z.object({
  supplier: z.string().trim().min(1).describe('Supplier name, as on the invoice'),
  amount: z.number().positive().describe('Amount in USDC'),
  payTo: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'a 20-byte hex address')
    .describe('The address the payment would go to'),
});

export type CheckPaymentInput = z.infer<typeof checkPaymentInput>;

export type CheckPaymentResult =
  | { status: 'settled'; message: string }
  | {
      status: 'held';
      reason: 'address_mismatch' | 'supplier_unknown' | 'over_limit';
      message: string;
      approvalUrl: string;
    };

/**
 * Demo rules only (Spike 4): no chain calls, no money. Addresses are compared by
 * code, never judged by a model; any mismatch is a hold with the approval link,
 * because consent must not depend on the agent app supporting pause-and-ask.
 */
export function checkPayment(input: unknown): CheckPaymentResult {
  const { supplier, amount, payTo } = checkPaymentInput.parse(input);
  const known = KNOWN_SUPPLIERS.find((s) => s.name.toLowerCase() === supplier.toLowerCase());
  const approvalUrl = `${APPROVAL_PAGE}?supplier=${encodeURIComponent(supplier)}&amount=${String(amount)}`;
  if (!known) {
    return {
      status: 'held',
      reason: 'supplier_unknown',
      message: `${supplier} is not an approved supplier. A person must approve this payment: ${approvalUrl}`,
      approvalUrl,
    };
  }
  if (payTo.toLowerCase() !== known.payTo.toLowerCase()) {
    return {
      status: 'held',
      reason: 'address_mismatch',
      message: `The pay-to address differs from ${known.name}'s address on file (${known.payTo}). Held for a person to approve: ${approvalUrl}`,
      approvalUrl,
    };
  }
  if (amount > known.orderLimit) {
    return {
      status: 'held',
      reason: 'over_limit',
      message: `${String(amount)} USDC is more than the approved order allows (${String(known.orderLimit)}). Held for a person to approve: ${approvalUrl}`,
      approvalUrl,
    };
  }
  return {
    status: 'settled',
    message: `Matches ${known.name}'s address on file and the approved order. It would be paid automatically.`,
  };
}
