import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  decisionTypes,
  formatUsdc,
  OUTCOME,
  paymentTypes,
  REASON_TEXT,
  REASONS,
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
import type { WebsiteProofs } from '../proofs/website.js';
import { holdWebsiteView } from '../proofs/view.js';

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
  /** Slice 15: suppliers' websites, shown on a changed-address hold. */
  websites?: Pick<WebsiteProofs, 'siteOnFile' | 'check'>;
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
 * What the supplier's website on file lists, for a changed-address hold (Slice 15 part 2). The
 * latest proof is shown; when there is none from the last few minutes, a check starts (one per site
 * at a time), and the page shows it once done.
 */
async function holdWebsite(
  store: Store,
  websites: Pick<WebsiteProofs, 'siteOnFile' | 'check'>,
  row: PaymentRequestRow,
  onFile: string,
) {
  const order = await store.orderByVault(row.vault);
  const url = order
    ? await websites.siteOnFile(row.account as Address, order.supplierId as Hex)
    : null;
  const proof = url === null ? undefined : await store.latestWebsiteProof(url);
  const now = Date.now();
  if (url !== null && (!proof || now - proof.createdAt.getTime() > HOLD_RECHECK_MS))
    websites.check(url).catch((e: unknown) => {
      console.error(`website check ${url}: ${e instanceof Error ? e.message : String(e)}`);
    });
  return holdWebsiteView({ url, proof, onFile, invoice: row.payTo, now });
}
/** A hold's website proof is checked again when it is older than this. */
const HOLD_RECHECK_MS = 10 * 60_000;

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
  // A changed address, or (D21) a supplier whose own site stopped listing the address on file:
  // there, the invoice pays the address on file, so that is the one to compare with.
  const onFile =
    row.reason === 'website_changed' ? row.payTo : (v.summary.addressOnFile as string | null);
  if (
    deps.websites &&
    row.status === 'held' &&
    typeof onFile === 'string' &&
    (onFile !== row.payTo || row.reason === 'website_changed')
  )
    try {
      v.summary.websiteProof = await holdWebsite(deps.store, deps.websites, row, onFile);
    } catch (e) {
      console.error(`hold website: ${e instanceof Error ? e.message : String(e)}`);
    }
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

/**
 * What one passkey signs to refuse a run's holds of one reason (D18, S16-2): the chain, the
 * account, the run, the reason and exactly the held payments' ids, sorted.
 */
export function groupRefusalChallenge(
  chainId: number,
  account: Address,
  runId: string,
  reason: string,
  ids: string[],
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'string' },
        { type: 'string' },
        { type: 'bytes32[]' },
      ],
      [
        'Countersign: refuse held payments',
        BigInt(chainId),
        account,
        runId,
        reason,
        [...ids].map((i) => i.toLowerCase() as Hex).sort(),
      ],
    ),
  );
}

const groupParams = z.object({
  runId: z.string().openapi({ param: { name: 'runId', in: 'path' } }),
});
const groupQuery = z.object({
  reason: z.enum(REASONS).openapi({ param: { name: 'reason', in: 'query' } }),
});

const getGroup = createRoute({
  method: 'get',
  path: '/v1/approvals/runs/{runId}',
  tags: ['Owner'],
  summary: 'A run’s holds of one reason, and the one challenge that refuses them all',
  description:
    'No token, like every approvals route: the passkey is the authorisation. The challenge covers exactly the listed payments (D18).',
  request: { params: groupParams, query: groupQuery },
  responses: {
    200: json(
      z
        .object({
          runId: z.string(),
          account: z.string(),
          reason: z.enum(REASONS),
          reasonText: z.string(),
          ids: z.array(z.string()),
          count: z.number(),
          challenge: z.string().nullable(),
          summary: z.string(),
        })
        .openapi('HeldGroup'),
      'The group',
    ),
    404: json(apiError, 'unknown_run'),
  },
});

const refuseGroup = createRoute({
  method: 'post',
  path: '/v1/approvals/runs/{runId}',
  tags: ['Owner'],
  summary: 'Refuse a run’s holds of one reason with one passkey signature',
  description:
    'Any one owner signs the challenge from the GET. The list is read again: if it changed, the answer is challenge_mismatch and nothing is refused. Each refused payment keeps the signature and the list.',
  request: {
    params: groupParams,
    query: groupQuery,
    body: { content: { 'application/json': { schema: z.object({ assertion: assertion }) } } },
  },
  responses: {
    200: json(
      z.object({
        runId: z.string(),
        reason: z.string(),
        refused: z.number(),
        ids: z.array(z.string()),
      }),
      'Refused',
    ),
    400: json(apiError, 'malformed_assertion'),
    404: json(apiError, 'unknown_run'),
    409: json(apiError, 'nothing_held'),
    422: json(apiError, 'challenge_mismatch or invalid_passkey'),
  },
});

export function registerApprovalRoutes(
  app: OpenAPIHono,
  deps: DecisionDeps & { chainId: number; publicUrl: string; proposals?: ProposalDeps },
): void {
  const { store, chainId, publicUrl } = deps;
  const owner = deps.proposals;

  /** A run's holds of one reason, sorted, and the account they belong to (D18). */
  const heldGroup = async (runId: string, reason: string) => {
    const run = await store.getRun(runId);
    if (!run) return null;
    const ids = (await store.listRun(runId))
      .filter((r) => r.status === 'held' && r.reason === reason)
      .map((r) => r.id.toLowerCase())
      .sort();
    return { account: run.account as Address, ids };
  };

  app.openapi(getGroup, async (c) => {
    const { runId } = c.req.valid('param');
    const { reason } = c.req.valid('query');
    const group = await heldGroup(runId, reason);
    if (!group) return c.json({ error: 'unknown_run' }, 404);
    const text = REASON_TEXT[reason];
    return c.json(
      {
        runId,
        account: group.account,
        reason,
        reasonText: text,
        ids: group.ids,
        count: group.ids.length,
        challenge:
          group.ids.length === 0
            ? null
            : groupRefusalChallenge(chainId, group.account, runId, reason, group.ids),
        summary: `Refuse ${String(group.ids.length)} held payments: ${text} Nothing is paid.`,
      },
      200,
    );
  });

  app.openapi(refuseGroup, async (c) => {
    const { runId } = c.req.valid('param');
    const { reason } = c.req.valid('query');
    const group = await heldGroup(runId, reason);
    if (!group) return c.json({ error: 'unknown_run' }, 404);
    if (group.ids.length === 0)
      return c.json(
        { error: 'nothing_held', message: `no payment in this run is held for ${reason}` },
        409,
      );
    // The list is read again here, so the signature must cover exactly what is held now.
    const challenge = groupRefusalChallenge(chainId, group.account, runId, reason, group.ids);
    let auth;
    try {
      auth = fromBrowser(c.req.valid('json').assertion, challenge);
    } catch (e) {
      if (!(e instanceof AssertionError)) throw e;
      return c.json(
        {
          error: e.code,
          message:
            e.code === 'challenge_mismatch'
              ? 'the held payments changed since they were shown; open them again and sign the new list'
              : e.message,
        },
        e.code === 'challenge_mismatch' ? 422 : 400,
      );
    }
    // Off chain, like refusing a proposal: a refusal moves no money. Any one owner (D36).
    const sig = await ownerSigOf(deps.chain, group.account, auth, true);
    if (!sig)
      return c.json({ error: 'invalid_passkey', message: 'not this account’s passkey' }, 422);
    const evidence = {
      group: { runId, reason, ids: group.ids, challenge },
      sigs: storedSigs([sig]),
    };
    let refused = 0;
    for (const id of group.ids)
      if (
        await store.transition(id, 'held', 'refused', {
          reason: 'user_refused',
          decidedBy: 'user_refused',
          decidedAt: new Date(),
          ownerAuth: evidence,
          detail: { group: { runId, reason } },
        })
      )
        refused++;
    return c.json({ runId, reason, refused, ids: group.ids }, 200);
  });

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
