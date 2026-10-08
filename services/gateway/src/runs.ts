import { REASON_TEXT, type PaymentStatus, type Reason } from '@countersign/shared';
import type { PaymentRequestRow } from './db/schema.js';

/**
 * A run of many invoices as the run board sees it (Slice 16, D20), and the numbers the
 * architecture says to publish, measured: from intake to the last decision, each paid invoice's
 * time to final, and the holds grouped by reason (D18) so a person can decide them together.
 */

/** Decided: paid and final, held for the owner, or stopped. In flight: anything else. */
const DECIDED: readonly PaymentStatus[] = [
  'settled',
  'held',
  'blocked',
  'refused',
  'expired',
  'failed',
];

export type ReasonGroup = { reason: Reason; text: string; count: number; ids: string[] };

export type RunSummary = {
  runId: string;
  account: string;
  size: number;
  submittedAt: string;
  decided: number;
  done: boolean;
  /** Intake to the last decision (or to now, while the run is still going). */
  elapsedMs: number;
  /** Each paid invoice, from its request to Monad's Finalized stage. */
  settled: { count: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  held: ReasonGroup[];
  blocked: ReasonGroup[];
};

/** The nearest-rank percentile of sorted values. */
const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? null : (sorted[Math.ceil(p * sorted.length) - 1] ?? null);

function grouped(rows: PaymentRequestRow[], status: PaymentStatus): ReasonGroup[] {
  const groups = new Map<Reason, string[]>();
  for (const r of rows)
    if (r.status === status && r.reason !== null)
      groups.set(r.reason, [...(groups.get(r.reason) ?? []), r.id]);
  return [...groups.entries()]
    .map(([reason, ids]) => ({ reason, text: REASON_TEXT[reason], count: ids.length, ids }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function runSummary(
  run: { id: string; account: string; size: number; createdAt: Date },
  rows: PaymentRequestRow[],
  now: Date,
): RunSummary {
  const decidedRows = rows.filter((r) => DECIDED.includes(r.status));
  const done = rows.length >= run.size && decidedRows.length === rows.length;
  // A paid invoice is decided when it is final; anything else when it was decided.
  const decidedAt = (r: PaymentRequestRow) =>
    (r.status === 'settled' ? r.finalizedAt : r.decidedAt)?.getTime() ?? null;
  const last = Math.max(...decidedRows.map((r) => decidedAt(r) ?? 0), run.createdAt.getTime());
  const settled = rows
    .filter((r) => r.status === 'settled' && r.finalizedAt !== null)
    .map((r) => (r.finalizedAt?.getTime() ?? 0) - r.requestedAt.getTime())
    .sort((a, b) => a - b);
  return {
    runId: run.id,
    account: run.account,
    size: run.size,
    submittedAt: run.createdAt.toISOString(),
    decided: decidedRows.length,
    done,
    elapsedMs: (done ? last : now.getTime()) - run.createdAt.getTime(),
    settled: {
      count: settled.length,
      p50Ms: percentile(settled, 0.5),
      p95Ms: percentile(settled, 0.95),
      maxMs: settled.at(-1) ?? null,
    },
    held: grouped(rows, 'held'),
    blocked: grouped(rows, 'blocked'),
  };
}
