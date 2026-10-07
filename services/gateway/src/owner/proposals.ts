import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { countersignAccountAbi, GAS_LIMITS } from '@countersign/chain';
import {
  accountDomain,
  formatUsdc,
  ownerActionTypes,
  supplierId,
  supplierSlug,
} from '@countersign/shared';
import type { ProposalRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { AssertionError, fromBrowser, type BrowserAssertion } from '../api/webauthn.js';
import type { WebAuthnAuth } from '../chain/types.js';
import { ownerSigned } from './passkey.js';
import { OwnerActionError, sendAndWait, type OwnerSendDeps } from './send.js';

/**
 * Approving a proposed supplier and order (Slice 9 part 2). An agent can only propose: it read a
 * quote, and nothing is real until the owner's passkey signs (money rule 8). Approving is one or
 * two owner actions, read live from the account: `setSupplier` when the supplier is not on file at
 * this address, then `approveOrder`, at consecutive owner nonces. Refusing changes nothing on
 * chain, so its passkey assertion is checked here against the account's own owner key.
 */

/** What approving reads from Monad. The real one is src/chain/monad.ts. */
export interface ProposalChain {
  ownerNonce(account: Address): Promise<bigint>;
  supplierOf(
    account: Address,
    supplierId: Hex,
  ): Promise<{ payTo: Address; active: boolean; activeAfter: number } | null>;
  usdcBalance(address: Address): Promise<bigint>;
  effectiveWaitingPeriod(account: Address): Promise<number>;
  ownerKey(account: Address): Promise<{ qx: Hex; qy: Hex }>;
  dryRun(to: Address, data: Hex): Promise<string | undefined>;
  finalizedReceipt(
    hash: Hex,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null>;
}

export type ProposalDeps = OwnerSendDeps & {
  store: Pick<Store, 'getProposal' | 'decideProposal' | 'pendingRelayerTx'>;
  chain: ProposalChain;
  chainId: number;
  publicUrl?: string;
};

/** The two signatures are valid for a week from the proposal: GET and POST agree on them. */
const SIGN_WITHIN = 7 * 86_400;

/** The challenge a refusal signs: fixed for this proposal, account and chain. */
export function refuseChallenge(chainId: number, account: Address, id: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
      ['Countersign: refuse proposal', id, account, BigInt(chainId)],
    ),
  );
}

type Step = {
  key: 'set_supplier' | 'approve_order';
  nonce: bigint;
  summary: string;
  challenge: Hex;
  typedData: unknown;
  call: (auth: WebAuthnAuth) => Hex;
  gas: bigint;
};

const strings = (o: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
  );

/** Everything approving needs, read live: what is on file, the nonce, the money. */
async function planOf(deps: ProposalDeps, p: ProposalRow) {
  const account = p.account as Address;
  const id = supplierId(supplierSlug(p.supplierName));
  const [onFile, nonce, usdc, waiting] = await Promise.all([
    deps.chain.supplierOf(account, id),
    deps.chain.ownerNonce(account),
    deps.chain.usdcBalance(account),
    deps.chain.effectiveWaitingPeriod(account),
  ]);
  const payTo = p.payTo as Address;
  const amount = BigInt(p.amount);
  const sameAddress = onFile !== null && onFile.payTo.toLowerCase() === payTo.toLowerCase();
  const needsSupplier = !(sameAddress && onFile.active);
  const deadline = BigInt(Math.floor(p.createdAt.getTime() / 1000) + SIGN_WITHIN);
  const domain = accountDomain(deps.chainId, account);
  const supplier = { supplierId: id, payTo, active: true, proofHash: zeroHash };
  const order = {
    orderId: keccak256(p.id as Hex),
    supplierId: id,
    // The order's hash is the quote the agent read, so the order points at its evidence.
    orderHash: p.documentHash as Hex,
    amount,
    expiry: BigInt(p.expiry),
  };
  const steps: Step[] = [];
  if (needsSupplier) {
    const message = { ...supplier, nonce, deadline };
    steps.push({
      key: 'set_supplier',
      nonce,
      summary:
        onFile === null
          ? `Add ${p.supplierName} as a supplier, paid only at ${payTo}`
          : `Change ${p.supplierName}'s address on file to ${payTo}, for every order`,
      challenge: hashTypedData({
        domain,
        types: ownerActionTypes,
        primaryType: 'SetSupplier',
        message,
      }),
      typedData: {
        domain,
        primaryType: 'SetSupplier',
        types: { SetSupplier: ownerActionTypes.SetSupplier },
        message: strings(message),
      },
      call: (auth) =>
        encodeFunctionData({
          abi: countersignAccountAbi,
          functionName: 'setSupplier',
          args: [id, payTo, true, zeroHash, nonce, deadline, auth],
        }),
      gas: GAS_LIMITS.setSupplier,
    });
  }
  const orderNonce = needsSupplier ? nonce + 1n : nonce;
  const orderMessage = { ...order, nonce: orderNonce, deadline };
  steps.push({
    key: 'approve_order',
    nonce: orderNonce,
    summary: `Open an order with ${p.supplierName} for ${formatUsdc(amount)} USDC`,
    challenge: hashTypedData({
      domain,
      types: ownerActionTypes,
      primaryType: 'ApproveOrder',
      message: orderMessage,
    }),
    typedData: {
      domain,
      primaryType: 'ApproveOrder',
      types: { ApproveOrder: ownerActionTypes.ApproveOrder },
      message: strings(orderMessage),
    },
    call: (auth) =>
      encodeFunctionData({
        abi: countersignAccountAbi,
        functionName: 'approveOrder',
        args: [
          order.orderId,
          id,
          order.orderHash,
          amount,
          order.expiry,
          orderNonce,
          deadline,
          auth,
        ],
      }),
    gas: GAS_LIMITS.approveOrder,
  });
  return {
    account,
    id,
    onFile,
    changesAddress: onFile !== null && !sameAddress,
    usdc,
    amount,
    enoughFunds: usdc >= amount,
    waiting,
    deadline,
    order,
    steps,
  };
}

/** One thing the owner can sign: its challenge, the typed data behind it, and what it does. */
export type ProposalAction = { challenge: Hex; typedData: unknown; summary: string };

/** What the owner's phone shows and signs for a proposal (GET /v1/approvals/{id}). */
export async function proposalApprovalView(deps: ProposalDeps, p: ProposalRow) {
  const plan = await planOf(deps, p);
  const now = Math.floor(Date.now() / 1000);
  const open = p.status === 'pending';
  const approvable = open && plan.enoughFunds && p.expiry > now && Number(plan.deadline) > now;
  const refuse = refuseChallenge(deps.chainId, plan.account, p.id as Hex);
  const actionsOf = (): Record<string, ProposalAction> => {
    if (!open) return {};
    const approve: Record<string, ProposalAction> = approvable
      ? Object.fromEntries(
          plan.steps.map((st) => [
            st.key,
            { challenge: st.challenge, typedData: st.typedData, summary: st.summary },
          ]),
        )
      : {};
    return {
      ...approve,
      refuse: {
        challenge: refuse,
        typedData: null,
        summary: `Refuse ${p.supplierName}: nothing is added and no money moves`,
      },
    };
  };
  return {
    id: p.id,
    kind: 'proposal' as const,
    status: p.status,
    title: 'A proposed supplier and order',
    summary: {
      supplierName: p.supplierName,
      website: p.website,
      payTo: p.payTo,
      amount: p.amount,
      amountUsdc: formatUsdc(plan.amount),
      expiry: new Date(p.expiry * 1000).toISOString(),
      account: p.account,
      supplierId: plan.id,
      orderId: plan.order.orderId,
      addressOnFile: plan.onFile?.payTo ?? null,
      changesAddress: plan.changesAddress,
      accountUsdc: formatUsdc(plan.usdc),
      enoughFunds: plan.enoughFunds,
      waitingPeriodSeconds: plan.waiting,
      signBy: new Date(Number(plan.deadline) * 1000).toISOString(),
    },
    differences: plan.changesAddress
      ? [{ field: 'payTo', onFile: plan.onFile?.payTo ?? '', onInvoice: p.payTo }]
      : [],
    actions: actionsOf(),
    statusUrl: `${deps.publicUrl ?? ''}/p/${p.id}`,
  };
}

async function pending(deps: ProposalDeps, id: string): Promise<ProposalRow> {
  const p = await deps.store.getProposal(id);
  if (!p) throw new OwnerActionError(404, 'unknown_proposal', 'no proposal with this id');
  if (p.status !== 'pending')
    throw new OwnerActionError(409, 'not_pending', `this proposal is already ${p.status}`);
  return p;
}

function checked(assertion: unknown, challenge: Hex, what: string): WebAuthnAuth {
  try {
    return fromBrowser(assertion as BrowserAssertion, challenge);
  } catch (e) {
    if (!(e instanceof AssertionError)) throw e;
    throw new OwnerActionError(
      e.code === 'challenge_mismatch' ? 422 : 400,
      e.code,
      `${what}: ${e.message}`,
    );
  }
}

/**
 * Approves with the owner's assertions, one per step (`set_supplier`, `approve_order`): every
 * assertion is checked against its own challenge before anything is sent, each call is dry-run
 * (a passkey that is not the owner's costs nothing), and each is final before the next. Read
 * live, so after a crash the supplier that already landed is not added again.
 */
export async function approveProposal(
  deps: ProposalDeps,
  id: string,
  assertions: Record<string, unknown>,
) {
  const p = await pending(deps, id);
  const plan = await planOf(deps, p);
  if (!plan.enoughFunds)
    throw new OwnerActionError(
      409,
      'insufficient_funds',
      `the account holds ${formatUsdc(plan.usdc)} USDC; the order needs ${formatUsdc(plan.amount)}`,
    );
  if (p.expiry <= Math.floor(Date.now() / 1000))
    throw new OwnerActionError(409, 'expired', 'the proposed order has already expired');
  const signed = plan.steps.map((s) => ({
    step: s,
    auth: checked(assertions[s.key], s.challenge, s.key),
  }));
  for (const { step, auth } of signed) {
    const data = step.call(auth);
    const refusal = await deps.chain.dryRun(plan.account, data);
    if (refusal === 'InvalidOwnerSignature')
      throw new OwnerActionError(422, 'invalid_passkey', 'not this account’s passkey');
    if (refusal === 'BadNonce')
      throw new OwnerActionError(
        409,
        'stale',
        'the account changed since this was shown; open it again',
      );
    if (refusal !== undefined)
      throw new OwnerActionError(409, 'contract_refuses', `${step.key} refused: ${refusal}`, {
        contract: refusal,
      });
    await sendAndWait(deps, plan.account, data, step.gas, `proposal ${id} ${step.key}`);
  }
  const decided = await deps.store.decideProposal(id, 'approved');
  return proposalApprovalView(deps, decided ?? p);
}

/** Refuses with the owner's passkey, checked against the account's owner key on chain. */
export async function refuseProposal(deps: ProposalDeps, id: string, assertion: unknown) {
  const p = await pending(deps, id);
  const auth = checked(
    assertion,
    refuseChallenge(deps.chainId, p.account as Address, p.id as Hex),
    'refuse',
  );
  if (!ownerSigned(await deps.chain.ownerKey(p.account as Address), auth))
    throw new OwnerActionError(422, 'invalid_passkey', 'not this account’s passkey');
  const decided = await deps.store.decideProposal(id, 'refused');
  if (!decided)
    throw new OwnerActionError(409, 'not_pending', 'this proposal was decided meanwhile');
  return proposalApprovalView(deps, decided);
}
