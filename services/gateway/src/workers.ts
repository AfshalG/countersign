import type { Address, Hex } from 'viem';
import type { WebsiteProofs } from './proofs/website.js';
import type { Chain } from './chain/types.js';
import type { Checker } from './checker.js';
import type { PaymentRequestRow } from './db/schema.js';
import type { Store } from './db/store.js';
import { checkOne } from './pipeline/check.js';
import { sendOne } from './pipeline/send.js';
import type { RelayerPool } from './relay/pool.js';

export type WorkerOptions = {
  store: Store;
  chain: Chain;
  checker: Checker;
  pool: RelayerPool;
  chainId: number;
  checkerTimeoutMs: number;
  /** How long a claimed request stays claimed; after that another worker (or a restarted gateway) takes it. */
  leaseMs: number;
  /** Checks run in parallel up to this many (D16: sized to the checker's rate limit). */
  checkConcurrency: number;
  sendConcurrency: number;
  tickMs: number;
  /** Slice 15 (D21): a supplier whose website stopped listing the address on file is held. */
  websites?: Pick<WebsiteProofs, 'websiteChanged'>;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs `fn` over `items`, at most `limit` at a time. */
async function each<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(runners);
}

const log = (what: string, row: PaymentRequestRow) => (e: unknown) => {
  // The request keeps its status and its lease runs out, so it is taken again; nothing is lost.
  console.error(`${what} ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
};

/**
 * The gateway's background work. Requests move only through the database, so any number of
 * workers (or a restarted gateway) can share it: each claim is a lease, and every step checks the
 * status it expects before changing it.
 */
export class Workers {
  private running = false;

  constructor(private readonly o: WorkerOptions) {}

  /**
   * On start, before taking new work: every payment that was settling when the gateway stopped is
   * looked up on chain. If its transaction is already in a finalized block it is settled (or failed,
   * if it reverted); if not, its signed transaction is handed back to its relayer to send again, same
   * nonce and same hash, so it can never be paid twice. Requests left in checking or released are
   * taken again once their leases run out.
   */
  async recover(): Promise<{ settled: number; resent: number }> {
    let settled = 0;
    let resent = 0;
    for (const row of await this.o.store.listByStatus('settling', 10_000)) {
      if (
        row.txHash === null ||
        row.rawTx === null ||
        row.relayer === null ||
        row.relayerNonce === null
      )
        continue;
      const receipt = await this.o.chain.finalizedReceipt(row.txHash as Hex);
      if (receipt) {
        const when = { blockNumber: receipt.blockNumber, finalizedAt: new Date() };
        const moved =
          receipt.status === 'success'
            ? await this.o.store.transition(row.id, 'settling', 'settled', {
                ...when,
                detail: { recovered: true },
              })
            : await this.o.store.transition(row.id, 'settling', 'failed', {
                ...when,
                reason: 'reverted',
                detail: { recovered: true },
              });
        if (moved) settled++;
        this.o.pool.included(row.txHash as Hex);
        continue;
      }
      this.o.pool.adopt({
        relayer: row.relayer as Address,
        nonce: row.relayerNonce,
        raw: row.rawTx as Hex,
        hash: row.txHash as Hex,
      });
      resent++;
    }
    // The same for relayer transactions that are not payments (judge-mode setup).
    for (const tx of await this.o.store.pendingRelayerTxs()) {
      const receipt = await this.o.chain.finalizedReceipt(tx.hash as Hex);
      if (receipt) {
        await this.o.store.markRelayerTxFinal(tx.hash, receipt.status);
        this.o.pool.included(tx.hash as Hex);
        continue;
      }
      this.o.pool.adopt({
        relayer: tx.relayer as Address,
        nonce: tx.nonce,
        raw: tx.raw as Hex,
        hash: tx.hash as Hex,
      });
      resent++;
    }
    return { settled, resent };
  }

  start(): void {
    this.running = true;
    void this.loop('check', async () => {
      const fresh = await this.o.store.claim(
        'requested',
        this.o.checkConcurrency * 2,
        this.o.leaseMs,
      );
      const abandoned = await this.o.store.claim(
        'checking',
        this.o.checkConcurrency,
        this.o.leaseMs,
      );
      const rows = [...fresh, ...abandoned];
      await each(rows, this.o.checkConcurrency, (row) =>
        checkOne(this.o, row).catch(log('check', row)),
      );
      return rows.length;
    });
    void this.loop('send', async () => {
      const rows = await this.o.store.claim('released', this.o.sendConcurrency * 4, this.o.leaseMs);
      await each(rows, this.o.sendConcurrency, (row) =>
        sendOne(this.o, row).catch(log('send', row)),
      );
      return rows.length;
    });
    let lastExpiry = 0;
    void this.loop('expire', async () => {
      if (Date.now() - lastExpiry < 5_000) return 0;
      lastExpiry = Date.now();
      return this.o.store.expireHeld(Math.floor(Date.now() / 1000));
    });
  }

  stop(): void {
    this.running = false;
  }

  /** Repeats `step`; sleeps a tick only when there was nothing to do. */
  private async loop(name: string, step: () => Promise<number>): Promise<void> {
    while (this.running) {
      let done = 0;
      try {
        done = await step();
      } catch (e) {
        console.error(`${name} worker: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (done === 0) await sleep(this.o.tickMs);
    }
  }
}
