export type TxRecord = {
  hash: string;
  wallet: string;
  nonce?: number | undefined;
  /** When the first send attempt started. */
  sentAt: number;
  /** When the endpoint accepted it (eth_sendRawTransaction returned). */
  acceptedAt?: number | undefined;
  attempts?: number | undefined;
  block?: number | undefined;
  proposedAt?: number | undefined;
  votedAt?: number | undefined;
  finalizedAt?: number | undefined;
  gasLimit: bigint;
  gasUsed?: bigint | undefined;
  status: 'success' | 'reverted' | 'missing';
};

export type Summary = {
  count: number;
  succeeded: number;
  reverted: number;
  missing: number;
  wallClockMs: number | null;
  /** First send to last acceptance: the time spent just getting transactions to the endpoints. */
  sendWindowMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  blocksUsed: number;
  maxPerBlock: number;
  gasUsedPerTx: number | null;
  gasUsedPerRevert: number | null;
  monSpent: number;
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(i, 0), sorted.length - 1)] ?? null;
}

/** Turns per-transaction records into one run's results. Fees are charged on the gas limit (Monad). */
export function summarise(records: TxRecord[], gasPriceWei: bigint): Summary {
  const included = records.filter((r) => r.status !== 'missing');
  const finalized = included.filter((r) => r.finalizedAt !== undefined);
  const perBlock = new Map<number, number>();
  for (const r of included)
    if (r.block !== undefined) perBlock.set(r.block, (perBlock.get(r.block) ?? 0) + 1);
  const latencies = finalized
    .map((r) => (r.finalizedAt as number) - r.sentAt)
    .sort((a, b) => a - b);
  const firstSend = records.length ? Math.min(...records.map((r) => r.sentAt)) : null;
  const lastFinal = finalized.length
    ? Math.max(...finalized.map((r) => r.finalizedAt as number))
    : null;
  const meanGas = (status: TxRecord['status']): number | null => {
    const used = records
      .filter((r) => r.status === status && r.gasUsed !== undefined)
      .map((r) => Number(r.gasUsed));
    return used.length ? Math.round(used.reduce((a, b) => a + b, 0) / used.length) : null;
  };
  const accepted = records
    .filter((r) => r.acceptedAt !== undefined)
    .map((r) => r.acceptedAt as number);
  // Monad charges the full gas limit of every included transaction, reverted or not; one that never landed costs nothing.
  const limitTotal = included.reduce((sum, r) => sum + r.gasLimit, 0n);
  return {
    count: records.length,
    succeeded: records.filter((r) => r.status === 'success').length,
    reverted: records.filter((r) => r.status === 'reverted').length,
    missing: records.filter((r) => r.status === 'missing').length,
    wallClockMs: firstSend !== null && lastFinal !== null ? lastFinal - firstSend : null,
    sendWindowMs: firstSend !== null && accepted.length ? Math.max(...accepted) - firstSend : null,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    blocksUsed: perBlock.size,
    maxPerBlock: perBlock.size ? Math.max(...perBlock.values()) : 0,
    gasUsedPerTx: meanGas('success'),
    gasUsedPerRevert: meanGas('reverted'),
    monSpent: Number(limitTotal * gasPriceWei) / 1e18,
  };
}
