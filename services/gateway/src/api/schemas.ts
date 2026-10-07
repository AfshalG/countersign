import { z } from '@hono/zod-openapi';
import { getAddress } from 'viem';
import { DECIDED_BY, PAYMENT_STATUSES, REASONS } from '@countersign/shared';

/**
 * The gateway's request and response shapes. The same zod schemas validate every request and
 * produce the OpenAPI document (`/openapi.json`, rendered at `/docs`), so the reference cannot
 * drift from what the API accepts (Slice 12, S12-5).
 */

const hexBytes = (bytes: number) =>
  z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${String(bytes * 2)}}$`));

export const bytes32 = hexBytes(32).openapi({
  example: '0x8b604573c997a05fcf9baa87b9bf2120ce26a0215c990c3dd9fdfa2222f0ed36',
});

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((a) => getAddress(a))
  .openapi({ example: '0x90f9931B748B26763161a8191C178Fe425C25fEc' });

/** A uint256 as a decimal string (or a safe integer), read as a bigint. */
export const uint = z
  .union([z.string().regex(/^\d{1,78}$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));

export const payment = z
  .object({
    amount: z
      .string()
      .regex(/^[1-9]\d{0,77}$/, 'a positive whole number of USDC base units')
      .openapi({
        description: 'USDC base units (6 decimals): "12500000" is 12.50 USDC',
        example: '12500000',
      }),
    invoiceHash: bytes32.openapi({
      description: 'keccak256(abi.encode(supplierId, normalized invoice number)); see the SDK',
    }),
    payTo: address.openapi({ description: 'The address as read from the invoice' }),
    deadline: z
      .number()
      .int()
      .positive()
      .openapi({ description: 'Unix seconds', example: 1791400000 }),
  })
  .openapi('Payment');

export const submission = z
  .object({
    vault: address.openapi({ description: "The order's vault" }),
    payment,
    agentSig: hexBytes(65).openapi({
      description: "The agent key's EIP-712 signature of the payment, in the vault's domain",
    }),
    document: z
      .unknown()
      .optional()
      .openapi({ description: 'What the checker reads: the invoice source or its fields' }),
  })
  .openapi('Submission');

export const ownerAuth = z
  .object({
    r: hexBytes(32),
    s: hexBytes(32),
    challengeIndex: uint,
    typeIndex: uint,
    authenticatorData: z.string().regex(/^0x([0-9a-fA-F]{2}){37,}$/),
    clientDataJSON: z.string().min(1).max(4096),
  })
  .openapi('OwnerAuth', {
    description: "The owner's passkey assertion (WebAuthn), as the vault verifies it",
  });

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

export const paymentView = z
  .object({
    id: z.string().openapi({
      description:
        'Derived from (account, vault, invoiceHash): the same invoice is the same request',
    }),
    runId: nullableString,
    status: z.enum(PAYMENT_STATUSES),
    reason: z.enum(REASONS).nullable(),
    decidedBy: z.enum(DECIDED_BY).nullable(),
    account: z.string(),
    vault: z.string(),
    payTo: z.string(),
    amount: z.string().openapi({ description: 'USDC base units' }),
    invoiceHash: z.string(),
    deadline: z.number(),
    evidence: z.unknown().openapi({
      description:
        'Why it was decided this way. On an address not on file: { contract, payTo: { onFile, invoice } }',
    }),
    tx: z.object({
      hash: nullableString,
      relayer: nullableString,
      nonce: nullableNumber,
      block: nullableNumber,
      proposedAt: nullableString,
      votedAt: nullableString,
      finalizedAt: nullableString,
    }),
    timings: z
      .object({ checkMs: nullableNumber, personMs: nullableNumber, settleMs: nullableNumber })
      .openapi({ description: 'Check, person and settlement times, kept apart, never summed' }),
  })
  .openapi('PaymentRequest');

export const created = z
  .object({ created: z.boolean(), request: paymentView })
  .openapi('PaymentSubmitted');

export const runCreated = z
  .object({
    runId: z.string(),
    requests: z.array(z.object({ id: z.string(), status: z.enum(PAYMENT_STATUSES) })),
  })
  .openapi('RunSubmitted');

export const runView = z
  .object({
    runId: z.string(),
    size: z.number(),
    byStatus: z.record(z.string(), z.number()),
    requests: z.array(paymentView),
  })
  .openapi('Run');

export const checkVerdict = z
  .object({
    verdict: z.enum(['would_settle', 'held', 'blocked']),
    reason: z.enum(REASONS).nullable(),
    decidedBy: z.enum(DECIDED_BY),
    evidence: z.unknown(),
  })
  .openapi('CheckVerdict');

export const apiError = z
  .object({
    error: z.string().openapi({
      description:
        'malformed, unauthorized, unknown_request, unknown_run, not_held, invalid_passkey, contract_refuses, internal',
    }),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
    contract: z.string().optional(),
  })
  .openapi('Error');

export const requestIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
});
