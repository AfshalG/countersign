/**
 * Spreads requests across endpoints without exceeding any one's rate limit
 * (testnet: Monad 50/s, Ankr 300 per 10 s, monadinfra 20/s). Each request goes to the
 * endpoint that is free soonest; ties go to the first listed.
 */
export class Pacer {
  private readonly nextFree: number[];

  constructor(private readonly perSecond: readonly number[]) {
    if (perSecond.some((r) => !(r > 0))) throw new Error('every rate must be positive');
    this.nextFree = perSecond.map(() => 0);
  }

  /** The next slot on one endpoint in particular. */
  takeOn(index: number, now: number): { index: number; at: number } {
    const at = Math.max(now, this.nextFree[index] ?? 0);
    this.nextFree[index] = at + 1000 / (this.perSecond[index] as number);
    return { index, at };
  }

  take(now: number): { index: number; at: number } {
    let index = 0;
    let at = Number.POSITIVE_INFINITY;
    this.nextFree.forEach((free, i) => {
      const start = Math.max(now, free);
      if (start < at) {
        index = i;
        at = start;
      }
    });
    this.nextFree[index] = at + 1000 / (this.perSecond[index] as number);
    return { index, at };
  }
}
