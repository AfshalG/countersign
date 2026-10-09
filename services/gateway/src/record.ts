import { getAddress, type Hex } from 'viem';
import { chain as monad } from '@countersign/chain';
import { evidenceHash, formatUsdc, REASON_TEXT } from '@countersign/shared';
import type { AgentDirectory } from './agents/identity.js';
import type { AdviceCheckRow, PaymentRequestRow } from './db/schema.js';
import type { Store } from './db/store.js';
import { supplierNameOf } from './suppliers.js';

/**
 * The payment record (Slice 18): one file per payment an auditor can check without trusting
 * Countersign. The payment, the document as the agent gave it, the checks and the hash of their
 * evidence, who decided and where that decision is on Monad, the settlement, and every event, as
 * one chain (architecture row 18, D21). `verify` says how to check it; the SDK's `verifyRecord`
 * and `countersign-verify` do it against Monad.
 */
export const RECORD_FORMAT = 'countersign-record/1';

export type RecordDeps = {
  store: Pick<
    Store,
    'events' | 'orderByVault' | 'approvedSupplierNames' | 'decisionRecord' | 'relayerTx'
  >;
  chainId: number;
  publicUrl: string;
  agents?: AgentDirectory;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ms = (a: Date | null, b: Date | null) => (a && b ? b.getTime() - a.getTime() : null);

/** Why a decision is not on Monad, when it is not. */
function offChainNote(row: PaymentRequestRow): string | null {
  if (row.status === 'settled')
    return 'A settled payment is on Monad as the vault’s PaymentExecuted event in its settlement transaction, which also carries the checker’s (or the owners’) signature.';
  if (row.status === 'refused')
    return typeof row.ownerAuth === 'object' && row.ownerAuth !== null && 'group' in row.ownerAuth
      ? 'Refused with one signature over a run’s held payments (D18), kept here with that signature: it is not a per-payment decision the vault records. (A refusal of one payment is written on Monad.)'
      : 'Refused before refusals were written on Monad (Slice 18), or with recording off: kept here with the owner’s signature.';
  if (row.decidedBy === 'rule')
    return 'Decided by the contract’s own rules, which anyone can re-run against Monad at the block: nobody signs such a decision, so none is written on chain.';
  if (row.reason === 'checker_unavailable')
    return 'The checker did not answer, so nothing signed this hold; it waits for the owner, whose decision is written on Monad.';
  if (['requested', 'checking', 'released', 'settling'].includes(row.status))
    return 'Not decided yet.';
  return null;
}

export async function paymentRecord(deps: RecordDeps, row: PaymentRequestRow) {
  const { store } = deps;
  const explorer = monad.blockExplorers.default.url;
  const order = await store.orderByVault(row.vault);
  const supplierName = await supplierNameOf(store, row.account, row.vault);
  const events = await store.events(row.id);
  const kept = await store.decisionRecord(row.id);
  const decisionTx = kept?.txHash ? await store.relayerTx(kept.txHash) : undefined;
  const agent = deps.agents
    ? deps.agents.viewOf(row.agentAddress)
    : row.agentAddress === null
      ? null
      : { address: row.agentAddress, agentId: null, registry: null };

  return {
    format: RECORD_FORMAT,
    generatedAt: new Date().toISOString(),
    chain: { id: deps.chainId, name: monad.name, explorer },
    payment: {
      id: row.id,
      runId: row.runId,
      account: getAddress(row.account),
      vault: getAddress(row.vault),
      order: order
        ? {
            orderId: order.orderId,
            supplierId: order.supplierId,
            supplierName,
            orderHash: order.orderHash,
            amountUsdc: formatUsdc(BigInt(order.amount)),
            expiry: order.expiry,
            approvedBlock: order.approvedBlock,
          }
        : null,
      invoiceHash: row.invoiceHash,
      payTo: getAddress(row.payTo),
      amount: row.amount,
      amountUsdc: formatUsdc(BigInt(row.amount)),
      deadline: row.deadline,
      agent,
      agentSig: row.agentSig,
    },
    document: {
      content: row.document ?? null,
      hash: row.document === null ? null : evidenceHash(row.document),
    },
    check: {
      status: row.status,
      reason: row.reason,
      reasonText: row.reason ? REASON_TEXT[row.reason] : null,
      decidedBy: row.decidedBy,
      at: iso(row.checkedAt),
      evidence: row.evidence ?? null,
      evidenceHash: row.evidence === null ? null : evidenceHash(row.evidence),
    },
    decision: {
      by: row.decidedBy,
      at: iso(row.decidedAt ?? row.checkedAt),
      ownerAuth: row.ownerAuth ?? null,
      onChain: kept
        ? {
            by: kept.decidedBy,
            decision: kept.decision,
            sigs: kept.sigs,
            tx: decisionTx
              ? {
                  hash: decisionTx.hash as Hex,
                  block: decisionTx.blockNumber,
                  status: decisionTx.status,
                  final: decisionTx.finalAt !== null,
                  url: `${explorer}/tx/${decisionTx.hash}`,
                }
              : null,
          }
        : null,
      onChainNote: kept
        ? decisionTx
          ? null
          : 'Kept to be written on Monad, not sent yet (recording is off, or it is on its way).'
        : offChainNote(row),
    },
    settlement: row.txHash
      ? {
          tx: {
            hash: row.txHash,
            relayer: row.relayer,
            nonce: row.relayerNonce,
            block: row.blockNumber,
            sentAt: iso(row.sentAt),
            finalizedAt: iso(row.finalizedAt),
            url: `${explorer}/tx/${row.txHash}`,
          },
          checkerSig: row.checkerSig,
        }
      : null,
    events: events.map((e) => ({
      from: e.fromStatus,
      to: e.toStatus,
      reason: e.reason,
      at: e.at.toISOString(),
      detail: e.detail ?? null,
    })),
    timings: {
      checkMs: ms(row.requestedAt, row.checkedAt),
      personMs: ms(row.checkedAt, row.decidedAt),
      settleMs: ms(row.sentAt, row.finalizedAt),
    },
    verify: [
      'check.evidenceHash is keccak256 of check.evidence as canonical JSON (RFC 8785: keys sorted, no whitespace); document.hash likewise of document.content.',
      `decision.onChain: its transaction on Monad (chain ${String(deps.chainId)}) emits DecisionRecorded from payment.vault with the same invoice hash, outcome, reason hash and evidence hash.`,
      'settlement: its transaction emits PaymentExecuted from payment.vault with payment.invoiceHash, payment.payTo and payment.amount.',
      'Or run `npx countersign-verify <this file>` (in @countersign/sdk), which checks each against Monad’s own RPC.',
    ],
  };
}

/** One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line break. */
const cell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const RECORDS_CSV_HEADER = [
  'date',
  'kind',
  'id',
  'invoice',
  'supplier',
  'amount_usdc',
  'outcome',
  'reason',
  'decided_by',
  'evidence_hash',
  'decision_tx',
  'settlement_tx',
  'record',
];

/** An account's payments and advice, newest first, one row each, for an auditor's spreadsheet. */
export async function recordsCsv(
  deps: Pick<RecordDeps, 'publicUrl'> & {
    store: Pick<Store, 'orderByVault' | 'approvedSupplierNames' | 'decisionRecord'>;
  },
  account: string,
  payments: PaymentRequestRow[],
  advice: AdviceCheckRow[],
): Promise<string> {
  const names = new Map<string, string | null>();
  const nameOf = async (vault: string) => {
    if (!names.has(vault)) names.set(vault, await supplierNameOf(deps.store, account, vault));
    return names.get(vault) ?? null;
  };
  const rows: { at: Date; cells: (string | number | null | undefined)[] }[] = [];
  for (const p of payments) {
    const read = (p.evidence as { read?: { number?: unknown } } | null)?.read;
    const kept = await deps.store.decisionRecord(p.id);
    rows.push({
      at: p.requestedAt,
      cells: [
        p.requestedAt.toISOString(),
        'payment',
        p.id,
        typeof read?.number === 'string' ? read.number : '',
        await nameOf(p.vault),
        formatUsdc(BigInt(p.amount)),
        p.status,
        p.reason,
        p.decidedBy,
        p.evidence === null ? '' : evidenceHash(p.evidence),
        kept?.txHash ?? '',
        p.txHash ?? '',
        `${deps.publicUrl}/v1/payments/${p.id}/record`,
      ],
    });
  }
  for (const a of advice)
    rows.push({
      at: a.createdAt,
      cells: [
        a.createdAt.toISOString(),
        'advice',
        a.id,
        a.invoiceNumber,
        await nameOf(a.vault),
        '',
        a.advice,
        a.reason,
        'checker',
        a.evidence === null ? '' : evidenceHash(a.evidence),
        '',
        '',
        `${deps.publicUrl}/v1/advice/${a.id}`,
      ],
    });
  rows.sort((x, y) => y.at.getTime() - x.at.getTime());
  return [RECORDS_CSV_HEADER, ...rows.map((r) => r.cells)]
    .map((cells) => cells.map(cell).join(','))
    .join('\r\n')
    .concat('\r\n');
}
