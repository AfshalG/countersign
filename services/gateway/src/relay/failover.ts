export type LaneRecord = {
  nonce: number;
  lastAcceptedAt: number | undefined;
  included: boolean;
  failed: boolean;
};

/**
 * A wallet's lowest pending nonce, if it was accepted by its endpoint `stallMs` ago and is
 * still not in a finalized block. Spike 3 saw an endpoint accept transactions and never
 * forward them; everything after that nonce waits on it, so the whole lane moves.
 */
export function stalledNonce(
  lane: readonly LaneRecord[],
  now: number,
  stallMs: number,
): number | undefined {
  const lowest = lane
    .filter((r) => !r.included && !r.failed)
    .reduce<LaneRecord | undefined>(
      (low, r) => (low === undefined || r.nonce < low.nonce ? r : low),
      undefined,
    );
  if (lowest?.lastAcceptedAt === undefined) return undefined;
  return now - lowest.lastAcceptedAt >= stallMs ? lowest.nonce : undefined;
}

/** The next endpoint after `current` that is not set aside; the plain next one if all are. */
export function nextEndpoint(
  current: number,
  setAsideUntil: readonly number[],
  now: number,
): number {
  const n = setAsideUntil.length;
  for (let step = 1; step < n; step++) {
    const i = (current + step) % n;
    if ((setAsideUntil[i] ?? 0) <= now) return i;
  }
  return (current + 1) % n;
}

/**
 * Where a stalled lane goes (Slice 16): of the other endpoints not set aside, the one with the
 * fewest lanes on it; if every other one is set aside, the least crowded of them anyway.
 */
export function leastCrowded(
  current: number,
  setAsideUntil: readonly number[],
  lanesOn: readonly number[],
  now: number,
): number {
  const others = setAsideUntil.map((_, i) => i).filter((i) => i !== current);
  if (others.length === 0) return current;
  const open = others.filter((i) => (setAsideUntil[i] ?? 0) <= now);
  const pool = open.length > 0 ? open : others;
  return pool.reduce((best, i) => ((lanesOn[i] ?? 0) < (lanesOn[best] ?? 0) ? i : best));
}
