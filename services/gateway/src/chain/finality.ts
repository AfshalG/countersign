import type { Hex } from 'viem';
import type { RawLog } from './indexer.js';
import type { Store } from '../db/store.js';
import type { RelayerPool } from '../relay/pool.js';
import { StageTracker } from './stages.js';

/** One monadNewHeads message: a block reaching a stage (Proposed, Voted, Finalized, Verified). */
export type Head = { number: number; blockId: string; commitState: string; at: number };

export type BlockReceipt = {
  transactionHash: Hex;
  status: 'success' | 'reverted';
  /** The receipt's logs (the order indexer reads them); absent where a source does not give them. */
  logs?: RawLog[];
};

/** Reading results, as the tracker needs it. The real one is src/chain/monad.ts. */
export interface Receipts {
  /** All receipts of a block; null if the node does not have the block yet. */
  blockReceipts(blockNumber: number): Promise<BlockReceipt[] | null>;
  latestFinalized(): Promise<number>;
}

export type FinalityDeps = {
  store: Store;
  receipts: Receipts;
  pool: Pick<RelayerPool, 'included'>;
  /** Told about every request that settled or failed, for the live feed. */
  onChange?: (requestId: string) => void;
  /** Every finalized block's logs, in order, empty blocks included (the order indexer). */
  onFinalizedBlock?: (blockNumber: number, logs: RawLog[]) => Promise<void>;
};

/** Blocks whose receipts are read ahead of the one being applied (Slice 16). */
const READ_AHEAD = 4;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Follows every block's stage and settles payments only at Finalized (money rule 4): Proposed
 * and Voted are recorded, never acted on. When a block is finalized its receipts are read in one
 * call (eth_getBlockReceipts; never a log scan, which Monad caps at 100 blocks), and each of our
 * transactions in it is settled or, if it reverted, failed. Blocks a dropped socket skipped are
 * read too, and polling the finalized tag keeps it going while the socket is down.
 */
export class FinalityTracker {
  private readonly stages = new StageTracker();
  /** The newest finalized block seen (a head or a poll). */
  private newest: number | undefined;
  private lastProcessed: number | undefined;
  private queue: Promise<void> = Promise.resolve();
  private poller: ReturnType<typeof setInterval> | undefined;
  /** Transactions that are not payments (judge-mode setup), by lower-case hash. */
  private readonly waiters = new Map<
    string,
    (result: { status: 'success' | 'reverted'; blockNumber: number }) => void
  >();

  constructor(private readonly deps: FinalityDeps) {}

  /**
   * Resolves when the transaction is in a finalized block, and clears it from its relayer's lane,
   * as settling does for payments. On timeout it rejects but the transaction is not forgotten: its
   * lane keeps re-sending it, and a later call can wait again.
   */
  waitFinal(
    hash: Hex,
    timeoutMs: number,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number }> {
    const key = hash.toLowerCase();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`transaction ${hash} not final after ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.waiters.set(key, (result) => {
        clearTimeout(timer);
        this.waiters.delete(key);
        resolve(result);
      });
    });
  }

  async onHead(head: Head): Promise<void> {
    this.stages.observe(head.number, head.blockId, head.commitState, head.at);
    if (head.commitState === 'Finalized') await this.finalizedUpTo(head.number);
  }

  /**
   * More than two finalized blocks not yet read (Slice 16): the relayer pool must not take a late
   * "included" for a stalled wallet then, or every wallet looks stalled at once.
   */
  /** Finalized blocks seen but not yet read (for /health). */
  lag(): number {
    return this.newest !== undefined && this.lastProcessed !== undefined
      ? Math.max(0, this.newest - this.lastProcessed)
      : 0;
  }

  behind(): boolean {
    return (
      this.newest !== undefined &&
      this.lastProcessed !== undefined &&
      this.newest - this.lastProcessed > 2
    );
  }

  startPolling(intervalMs: number): void {
    this.stopPolling();
    this.poller = setInterval(() => {
      this.deps.receipts
        .latestFinalized()
        .then((n) =>
          this.lastProcessed === undefined || n > this.lastProcessed
            ? this.finalizedUpTo(n)
            : undefined,
        )
        .catch((e: unknown) => {
          console.error(`finality poll: ${e instanceof Error ? e.message : String(e)}`);
        });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  /**
   * Processes every block up to `n` in order (heads and polls share the queue). Receipts for the
   * next few blocks are read while one is applied (Slice 16: under a run, Monad finalizes blocks
   * faster than one read at a time keeps up with, and payments were marked final seconds late).
   */
  private finalizedUpTo(n: number): Promise<void> {
    if (this.newest === undefined || n > this.newest) this.newest = n;
    this.queue = this.queue
      .then(async () => {
        const from = this.lastProcessed === undefined ? n : this.lastProcessed + 1;
        const ahead = new Map<number, Promise<BlockReceipt[]>>();
        const read = (k: number) => {
          if (k > n || ahead.has(k)) return;
          const reading = this.receiptsOf(k);
          reading.catch(() => undefined); // awaited in order below; never an unhandled rejection
          ahead.set(k, reading);
        };
        for (let k = from; k <= n; k++) {
          for (let j = k; j < k + READ_AHEAD; j++) read(j);
          const receipts = await (ahead.get(k) as Promise<BlockReceipt[]>);
          ahead.delete(k);
          await this.applyBlock(k, receipts);
          this.lastProcessed = k;
        }
      })
      .catch((e: unknown) => {
        // The block stays unprocessed and is retried with the next finalized head or poll.
        console.error(`finality: ${e instanceof Error ? e.message : String(e)}`);
      });
    return this.queue;
  }

  private async receiptsOf(blockNumber: number): Promise<BlockReceipt[]> {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const receipts = await this.deps.receipts.blockReceipts(blockNumber);
      if (receipts !== null) return receipts;
      await sleep(100 * attempt); // the node serving the call may be a moment behind the socket
    }
    throw new Error(`no receipts for finalized block ${String(blockNumber)}`);
  }

  private async applyBlock(blockNumber: number, receipts: BlockReceipt[]): Promise<void> {
    const byHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]));
    // Payments first: nothing an agent or a person waits on queues behind indexing (Slice 16).
    if (receipts.length > 0) {
      const ours = await this.deps.store.settlingByTx([...byHash.keys()]);
      const stages = this.stages.stagesOf(blockNumber);
      // Each payment is its own row and transaction, so a busy block's are written together.
      await Promise.all(ours.map((row) => this.settle(row, byHash, blockNumber, stages)));
    }
    if (this.deps.onFinalizedBlock) {
      // Indexing never holds up settling payments: on an error the account falls behind and the
      // indexer's catch-up reads that block again.
      await this.deps
        .onFinalizedBlock(
          blockNumber,
          receipts.flatMap((r) => r.logs ?? []),
        )
        .catch((e: unknown) => {
          console.error(`indexer: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
    if (receipts.length === 0) return;
    // Setup transactions (an order approved, an account made) after indexing: whoever waits on one
    // may read the order's index next.
    for (const tx of await this.deps.store.pendingRelayerTxsByHash([...byHash.keys()])) {
      const receipt = byHash.get(tx.hash.toLowerCase());
      if (!receipt) continue;
      await this.deps.store.markRelayerTxFinal(tx.hash, receipt.status);
      this.deps.pool.included(receipt.transactionHash);
    }
    for (const [key, done] of [...this.waiters]) {
      const receipt = byHash.get(key);
      if (!receipt) continue;
      this.deps.pool.included(receipt.transactionHash);
      done({ status: receipt.status, blockNumber });
    }
  }

  private async settle(
    row: Awaited<ReturnType<Store['settlingByTx']>>[number],
    byHash: Map<string, BlockReceipt>,
    blockNumber: number,
    stages: ReturnType<StageTracker['stagesOf']>,
  ): Promise<void> {
    const time = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms));
    const receipt = byHash.get((row.txHash ?? '').toLowerCase());
    if (!receipt) return;
    const when = {
      blockNumber,
      proposedAt: time(stages?.Proposed) ?? null,
      votedAt: time(stages?.Voted) ?? null,
      finalizedAt: time(stages?.Finalized) ?? new Date(),
    };
    const moved =
      receipt.status === 'success'
        ? await this.deps.store.transition(row.id, 'settling', 'settled', when)
        : await this.deps.store.transition(row.id, 'settling', 'failed', {
            ...when,
            reason: 'reverted',
            detail: { tx: receipt.transactionHash },
          });
    this.deps.pool.included(receipt.transactionHash);
    if (moved) this.deps.onChange?.(row.id);
  }
}
