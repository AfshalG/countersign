/**
 * Per-wallet nonces, tracked locally: Monad hides pending transactions from
 * eth_getTransactionByHash and holds nonce gaps, so the sender must know which
 * nonces it has used. A released nonce (a send that failed before reaching the pool)
 * is reused first, so no gap is left behind.
 */
export class NonceAllocator {
  private readonly nextFresh = new Map<string, number>();
  private readonly released = new Map<string, number[]>();

  constructor(start: Record<string, number>) {
    for (const [wallet, nonce] of Object.entries(start)) {
      this.nextFresh.set(wallet, nonce);
      this.released.set(wallet, []);
    }
  }

  next(wallet: string): number {
    const fresh = this.nextFresh.get(wallet);
    const pool = this.released.get(wallet);
    if (fresh === undefined || pool === undefined) throw new Error(`unknown wallet ${wallet}`);
    if (pool.length > 0) {
      pool.sort((a, b) => a - b);
      return pool.shift() as number;
    }
    this.nextFresh.set(wallet, fresh + 1);
    return fresh;
  }

  release(wallet: string, nonce: number): void {
    const pool = this.released.get(wallet);
    if (!pool) throw new Error(`unknown wallet ${wallet}`);
    if (!pool.includes(nonce)) pool.push(nonce);
  }
}
