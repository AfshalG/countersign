import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { hashTypedData, keccak256, stringToHex, type Address, type Hex } from 'viem';
import {
  decisionTypes,
  formatUsdc,
  OUTCOME,
  paymentTypes,
  REASON_TEXT,
  vaultDomain,
} from '@countersign/shared';
import type { Chain, Decision, WebAuthnAuth } from '../chain/types.js';
import type { PaymentRequestRow, ProposalRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { paymentOf } from '../payment.js';
import { HEADLINE } from './status-page.js';
import { AssertionError, fromBrowser } from './webauthn.js';
import { ownerSigOf, storedSigs } from '../owner/signers.js';
import { collect, progress } from '../owner/collect.js';
import {
  approveProposal,
  proposalApprovalView,
  refuseProposal,
  type ProposalDeps,
} from '../owner/proposals.js';
import { OwnerActionError } from '../owner/send.js';

/**
 * The owner's decisions on held payments (Slice 9, D35). The same checks back the service-token
 * routes (`/v1/payments/{id}/approve`, `/refuse`) and the passkey routes (`/v1/approvals/{id}`):
 * the vault checks the passkey (a simulated `payWithOwner`, or a `recordDecisionByOwner` call),
 * so a wrong passkey costs nothing and changes nothing.
 */

export type DecisionDeps = {
  store: Store;
  chain: Pick<Chain, 'simulate' | 'verifyOwnerDecision' | 'ownership'>;
  chainId: number;
};

type Refused = {
  ok: false;
  status: 404 | 409 | 422;
  body: { error: string; status?: string; reason?: string; contract?: string };
};
/** Decided, or (D36) the passkey counted and the action waits for more owners: `waiting`. */
export type DecisionResult =
  { ok: true; row: PaymentRequestRow; waiting?: { need: number; signed: number[] } } | Refused;

/** The digest an owner signs to pay a held payment once: the vault's EIP-712 Payment. */
const paymentDigest = (row: PaymentRequestRow, chainId: number) =>
  hashTypedData({
    domain: vaultDomain(chainId, row.vault as Hex),
    types: paymentTypes,
    primaryType: 'Payment',
    message: paymentOf(row),
  });

async function heldRow(store: Store, id: string): Promise<PaymentRequestRow | Refused> {
  const row = await store.get(id);
  if (!row) return { ok: false, status: 404, body: { error: 'unknown_request' } };
  if (row.status !== 'held')
    return { ok: false, status: 409, body: { error: 'not_held', status: row.status } };
  return row;
}

async function after(store: Store, id: string): Promise<DecisionResult> {
  const row = await store.get(id);
  return row ? { ok: true, row } : { ok: false, status: 404, body: { error: 'unknown_request' } };
}

/**
 * Pays a held payment once, through `payWithOwner`, once as many owners as the account's release
 * threshold have signed (D36; one for most accounts) and the vault accepts their passkeys.
 */
export async function payOnce(
  deps: DecisionDeps,
  id: string,
  auth: WebAuthnAuth,
): Promise<DecisionResult> {
  const row = await heldRow(deps.store, id);
  if ('ok' in row) return row;
  let collected;
  try {
    collected = await collect(deps, {
      account: row.account as Address,
      digest: paymentDigest(row, deps.chainId),
      auth,
      threshold: 'release',
      purpose: `pay_once:${row.id}`,
    });
  } catch (e) {
    if (!(e instanceof OwnerActionError)) throw e;
    return { ok: false, status: 422, body: { error: e.code } };
  }
  if (!collected.ready)
    return { ok: true, row, waiting: { need: collected.need, signed: collected.signed } };
  const sigs = collected.sigs;
  const refusal = await deps.chain.simulate(row.vault as Address, paymentOf(row), {
    kind: 'payWithOwner',
    ownerSigs: sigs,
  });
  if (refusal?.error === 'InvalidOwnerSignature')
    return { ok: false, status: 422, body: { error: 'invalid_passkey' } };
  if (refusal)
    return {
      ok: false,
      status: 409,
      body: { error: 'contract_refuses', reason: refusal.reason, contract: refusal.error },
    };
  const moved = await deps.store.transition(row.id, 'held', 'released', {
    ownerAuth: storedSigs(sigs),
    decidedBy: 'user_once',
    decidedAt: new Date(),
  });
  if (!moved) return { ok: false, status: 409, body: { error: 'not_held' } };
  return after(deps.store, row.id);
}

/** Refuses a held payment if the owner's passkey signed this decision; a refusal ends the agent's run (money rule 7). */
export async function refuseHeld(
  deps: DecisionDeps,
  id: string,
  auth: WebAuthnAuth,
  decision: { reasonHash: Hex; evidenceHash: Hex },
): Promise<DecisionResult> {
  const row = await heldRow(deps.store, id);
  if ('ok' in row) return row;
  const signed: Decision = {
    invoiceHash: row.invoiceHash as Hex,
    outcome: OUTCOME.refused,
    ...decision,
  };
  const sig = await ownerSigOf(deps.chain, row.account as Address, auth);
  if (!sig || !(await deps.chain.verifyOwnerDecision(row.vault as Address, signed, [sig])))
    return { ok: false, status: 422, body: { error: 'invalid_passkey' } };
  const moved = await deps.store.transition(row.id, 'held', 'refused', {
    reason: 'user_refused',
    decidedBy: 'user_refused',
    decidedAt: new Date(),
    ownerAuth: storedSigs([sig]),
    detail: { decision },
  });
  if (!moved) return { ok: false, status: 409, body: { error: 'not_held' } };
  return after(deps.store, row.id);
}

// ---------- the approvals view (what the phone shows and signs) ----------

/** The refusal the approvals routes record: fixed, so the challenge shown is the one checked. */
export const REFUSED_BY_OWNER = keccak256(stringToHex('refused by the owner'));
const refusalOf = (row: PaymentRequestRow) => ({
  reasonHash: REFUSED_BY_OWNER,
  evidenceHash: row.id as Hex,
});

const typedAction = z.object({
  challenge: z.string().openapi({
    description: 'The EIP-712 digest the passkey signs as its WebAuthn challenge',
  }),
  typedData: z.unknown().openapi({
    description: 'The typed data behind the challenge (bigints as strings), to show or re-check',
  }),
  summary: z
    .string()
    .optional()
    .openapi({ description: 'What signing this does, in plain words (proposals)' }),
  signatures: z
    .object({
      need: z.number().int().openapi({ description: 'Owners whose passkeys this action needs' }),
      signed: z
        .array(z.number().int())
        .openapi({ description: 'Owners (their index on the account) who have signed it' }),
    })
    .optional()
    .openapi({ description: 'D36: "1 of 2 signed". Absent when the chain could not be read' }),
});

export const approvalView = z
  .object({
    id: z.string(),
    kind: z.enum(['payment', 'proposal']),
    status: z.string(),
    title: z.string(),
    summary: z.record(z.string(), z.unknown()),
    differences: z.array(
      z.object({ field: z.string(), onFile: z.string(), onInvoice: z.string() }),
    ),
    actions: z.record(z.string(), typedAction).openapi({
      description:
        'For a held payment: refuse, and pay_once when its address is the one on file (the vault pays nowhere else, even for the owner). Empty once decided',
    }),
    statusUrl: z.string(),
  })
  .openapi('Approval');

export function paymentApproval(
  row: PaymentRequestRow,
  chainId: number,
  publicUrl: string,
): z.infer<typeof approvalView> {
  const evidence = (row.evidence ?? {}) as { payTo?: { onFile?: string; invoice?: string } };
  const onFile = evidence.payTo?.onFile ?? null;
  // The vault pays only the supplier's address on file, even with the owner's passkey
  // (test_TheOwnerStillPaysOnlyTheAddressOnFile), so a new address is never offered as pay once:
  // the owner refuses it, or changes the supplier's address on file first (a proposal).
  const offFile = onFile !== null && onFile.toLowerCase() !== row.payTo.toLowerCase();
  const payment = paymentOf(row);
  const domain = vaultDomain(chainId, row.vault as Hex);
  const decision = {
    invoiceHash: payment.invoiceHash,
    outcome: OUTCOME.refused,
    ...refusalOf(row),
  };
  const actions =
    row.status === 'held'
      ? {
          ...(offFile
            ? {}
            : {
                pay_once: {
                  challenge: hashTypedData({
                    domain,
                    types: paymentTypes,
                    primaryType: 'Payment',
                    message: payment,
                  }),
                  typedData: {
                    domain,
                    types: paymentTypes,
                    primaryType: 'Payment',
                    message: {
                      ...payment,
                      amount: payment.amount.toString(),
                      deadline: payment.deadline.toString(),
                    },
                  },
                },
              }),
          refuse: {
            challenge: hashTypedData({
              domain,
              types: decisionTypes,
              primaryType: 'Decision',
              message: decision,
            }),
            typedData: { domain, types: decisionTypes, primaryType: 'Decision', message: decision },
          },
        }
      : {};
  return {
    id: row.id,
    kind: 'payment',
    status: row.status,
    title: HEADLINE[row.status] ?? row.status,
    summary: {
      amount: row.amount,
      amountUsdc: formatUsdc(BigInt(row.amount)),
      payTo: row.payTo,
      addressOnFile: onFile,
      payOnce: row.status !== 'held' ? null : offFile ? 'address_not_on_file' : 'offered',
      reason: row.reason,
      reasonText: row.reason ? REASON_TEXT[row.reason] : null,
      account: row.account,
      vault: row.vault,
      invoiceHash: row.invoiceHash,
      deadline: new Date(row.deadline * 1000).toISOString(),
      txHash: row.txHash,
    },
    differences: offFile ? [{ field: 'payTo', onFile, onInvoice: row.payTo }] : [],
    actions,
    statusUrl: `${publicUrl}/p/${row.id}`,
  };
}

/**
 * The payment's view with what each action still needs (D36): pay once needs the release
 * threshold, refusing any one owner. If the chain cannot be read, the view goes without it.
 */
export async function paymentApprovalView(
  deps: DecisionDeps,
  row: PaymentRequestRow,
  publicUrl: string,
): Promise<z.infer<typeof approvalView>> {
  const v = paymentApproval(row, deps.chainId, publicUrl);
  try {
    const account = row.account as Address;
    for (const [key, action] of Object.entries(v.actions)) {
      action.signatures = await progress(
        deps,
        account,
        action.challenge as Hex,
        key === 'pay_once' ? 'release' : 'one',
      );
    }
  } catch (e) {
    console.error(`approval signatures: ${e instanceof Error ? e.message : String(e)}`);
  }
  return v;
}

/** A proposal's view; approving it on chain (setSupplier, approveOrder) is Slice 9 part 2. */
export function proposalApproval(p: ProposalRow, publicUrl: string): z.infer<typeof approvalView> {
  return {
    id: p.id,
    kind: 'proposal',
    status: p.status,
    title: 'A proposed supplier and order',
    summary: {
      supplierName: p.supplierName,
      website: p.website,
      payTo: p.payTo,
      amount: p.amount,
      amountUsdc: formatUsdc(BigInt(p.amount)),
      expiry: new Date(p.expiry * 1000).toISOString(),
      account: p.account,
    },
    differences: [],
    actions: {},
    statusUrl: `${publicUrl}/p/${p.id}`,
  };
}

// ---------- routes ----------

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const apiError = z.object({
  error: z.string(),
  status: z.string().optional(),
  message: z.string().optional(),
});
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });

const getApproval = createRoute({
  method: 'get',
  path: '/v1/approvals/{id}',
  tags: ['Owner'],
  summary: 'What the owner’s phone shows and signs, for a held payment or a proposal',
  description:
    'No token: it shows only what is public on chain or in the agent’s message, and acting on it needs the owner’s passkey. CORS is open for the approver app.',
  request: { params: idParam },
  responses: { 200: json(approvalView, 'The approval'), 404: json(apiError, 'unknown_approval') },
});

const assertion = z
  .object({
    authenticatorData: z.string().min(1).max(2048).openapi({ description: 'Hex or base64url' }),
    clientDataJSON: z
      .string()
      .min(1)
      .max(4096)
      .openapi({ description: 'The JSON string, or base64url' }),
    signature: z
      .union([z.object({ r: z.string(), s: z.string() }), z.string().min(1).max(512)])
      .openapi({ description: '{ r, s } as hex (ox), or a DER signature as hex or base64url' }),
  })
  .openapi('PasskeyAssertion', { description: 'The assertion as the browser gives it' });

const decide = createRoute({
  method: 'post',
  path: '/v1/approvals/{id}',
  tags: ['Owner'],
  summary: 'Decide with the owner’s passkey: pay once or refuse',
  description:
    'The passkey must have signed that action’s challenge (from the GET). It is checked by the vault itself before anything changes.',
  request: {
    params: idParam,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            action: z.enum(['pay_once', 'refuse', 'approve']).openapi({
              description:
                'A held payment: pay_once or refuse. A proposal: approve (with `assertions`, one per approve action) or refuse',
            }),
            assertion: assertion.optional(),
            assertions: z.record(z.string(), assertion).optional().openapi({
              description: 'For approving a proposal: `{ set_supplier, approve_order }` as offered',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: json(approvalView, 'Decided; a paid-once payment settles like any other'),
    202: json(
      approvalView,
      'Counted: the action waits for more owners’ passkeys (D36); `signatures` says how many',
    ),
    400: json(apiError, 'malformed or malformed_assertion'),
    404: json(apiError, 'unknown_request'),
    409: json(apiError, 'not_held, or contract_refuses'),
    422: json(
      apiError,
      'invalid_passkey, challenge_mismatch (the passkey signed another action), or not_offered (pay_once for an address not on file)',
    ),
  },
});

export function registerApprovalRoutes(
  app: OpenAPIHono,
  deps: DecisionDeps & { chainId: number; publicUrl: string; proposals?: ProposalDeps },
): void {
  const { store, chainId, publicUrl } = deps;
  const owner = deps.proposals;

  app.openapi(getApproval, async (c) => {
    const id = c.req.valid('param').id;
    const row = await store.get(id);
    if (row) return c.json(await paymentApprovalView(deps, row, publicUrl), 200);
    const proposal = await store.getProposal(id);
    if (!proposal) return c.json({ error: 'unknown_approval' }, 404);
    if (owner) {
      try {
        return c.json(await proposalApprovalView(owner, proposal), 200);
      } catch (e) {
        // The chain did not answer: show the proposal, with nothing to sign until it does.
        console.error(`proposal view: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return c.json(proposalApproval(proposal, publicUrl), 200);
  });

  app.openapi(decide, async (c) => {
    const id = c.req.valid('param').id;
    const body = c.req.valid('json');
    const row = await store.get(id);
    if (!row) {
      const proposal = await store.getProposal(id);
      if (!proposal || !owner) return c.json({ error: 'unknown_request' }, 404);
      if (body.action === 'pay_once')
        return c.json({ error: 'not_offered', message: 'A proposal is approved or refused' }, 422);
      try {
        if (body.action === 'approve') {
          if (!body.assertions || Object.keys(body.assertions).length === 0)
            return c.json({ error: 'malformed', message: 'approve takes `assertions`' }, 400);
          const v = await approveProposal(owner, id, body.assertions);
          // Still pending after approving: counted, waiting for more owners (D36).
          return c.json(v, v.status === 'pending' ? 202 : 200);
        }
        if (!body.assertion)
          return c.json({ error: 'malformed', message: 'refuse takes `assertion`' }, 400);
        return c.json(await refuseProposal(owner, id, body.assertion), 200);
      } catch (e) {
        if (!(e instanceof OwnerActionError) || e.status === 429) throw e;
        return c.json({ error: e.code, message: e.message }, e.status);
      }
    }
    if (body.action === 'approve')
      return c.json(
        { error: 'not_offered', message: 'A held payment is paid once or refused' },
        422,
      );
    if (!body.assertion)
      return c.json({ error: 'malformed', message: `${body.action} takes \`assertion\`` }, 400);
    if (row.status !== 'held') return c.json({ error: 'not_held', status: row.status }, 409);
    const action = paymentApproval(row, chainId, publicUrl).actions[body.action];
    if (!action)
      return c.json(
        {
          error: 'not_offered',
          message: 'The vault pays only the address on file; refuse, or change the supplier first',
        },
        422,
      );
    let auth: WebAuthnAuth;
    try {
      auth = fromBrowser(body.assertion, action.challenge as Hex);
    } catch (e) {
      if (!(e instanceof AssertionError)) throw e;
      return e.code === 'challenge_mismatch'
        ? c.json({ error: e.code, message: e.message }, 422)
        : c.json({ error: e.code, message: e.message }, 400);
    }
    const result =
      body.action === 'pay_once'
        ? await payOnce(deps, id, auth)
        : await refuseHeld(deps, id, auth, refusalOf(row));
    if (result.ok)
      return c.json(
        await paymentApprovalView(deps, result.row, publicUrl),
        result.waiting ? 202 : 200,
      );
    switch (result.status) {
      case 404:
        return c.json(result.body, 404);
      case 409:
        return c.json(result.body, 409);
      default:
        return c.json(result.body, 422);
    }
  });
}
