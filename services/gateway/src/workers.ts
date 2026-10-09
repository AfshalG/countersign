import type { Address, Hex } from 'viem';
import type { WebsiteProofs } from './proofs/website.js';
import type { Chain } from './chain/types.js';
import type { Checker } from './checker.js';
import type { PaymentRequestRow } from './db/schema.js';
import type { Store } from './db/store.js';
import { checkOne } from './pipeline/check.js';
import type { DecisionRecorder } from './decisions.js';
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
  /** Slice 18: a checker's hold is written on Monad. */
  decisions?: Pick<DecisionRecorder, 'record'>;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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
    void this.pipeline(
      'check',
      this.o.checkConcurrency,
      async (free) => {
        const fresh = await this.o.store.claim('requested', free, this.o.leaseMs);
        const abandoned =
          fresh.length < free
            ? await this.o.store.claim('checking', free - fresh.length, this.o.leaseMs)
            : [];
        return [...fresh, ...abandoned];
      },
      (row) => checkOne(this.o, row).catch(log('check', row)),
    );
    void this.pipeline(
      'send',
      this.o.sendConcurrency,
      (free) => this.o.store.claim('released', free, this.o.leaseMs),
      (row) => sendOne(this.o, row).catch(log('send', row)),
    );
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

  /**
   * Keeps `slots` payments in work at once (Slice 16): a payment is claimed as soon as a slot frees,
   * so one slow check never holds up the ones claimed with it (they used to wait for their whole
   * batch). One claimer per worker, so the database is asked once per tick, not once per slot.
   */
  private async pipeline(
    name: string,
    slots: number,
    claim: (free: number) => Promise<PaymentRequestRow[]>,
    work: (row: PaymentRequestRow) => Promise<void>,
  ): Promise<void> {
    let busy = 0;
    let wake: (() => void) | undefined;
    const rest = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, this.o.tickMs);
      });
    while (this.running) {
      const free = slots - busy;
      let claimed = 0;
      if (free > 0) {
        try {
          const rows = await claim(free);
          claimed = rows.length;
          for (const row of rows) {
            busy++;
            void work(row).finally(() => {
              busy--;
              wake?.();
            });
          }
        } catch (e) {
          console.error(`${name} worker: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Claim again at once while there is work and room; otherwise wait for a slot or a tick.
      if (claimed === 0 || claimed === free) await rest();
      wake = undefined;
    }
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
