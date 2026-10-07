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
  private lastProcessed: number | undefined;
  private queue: Promise<void> = Promise.resolve();
  private poller: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: FinalityDeps) {}

  async onHead(head: Head): Promise<void> {
    this.stages.observe(head.number, head.blockId, head.commitState, head.at);
    if (head.commitState === 'Finalized') await this.finalizedUpTo(head.number);
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

  /** Processes every block up to `n` in order, one at a time (heads and polls share the queue). */
  private finalizedUpTo(n: number): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const from = this.lastProcessed === undefined ? n : this.lastProcessed + 1;
        for (let k = from; k <= n; k++) {
          await this.processBlock(k);
          this.lastProcessed = k;
        }
      })
      .catch((e: unknown) => {
        // The block stays unprocessed and is retried with the next finalized head or poll.
        console.error(`finality: ${e instanceof Error ? e.message : String(e)}`);
      });
    return this.queue;
  }

  private async processBlock(blockNumber: number): Promise<void> {
    let receipts: BlockReceipt[] | null = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      receipts = await this.deps.receipts.blockReceipts(blockNumber);
      if (receipts !== null) break;
      await sleep(100 * attempt); // the node serving the call may be a moment behind the socket
    }
    if (receipts === null)
      throw new Error(`no receipts for finalized block ${String(blockNumber)}`);
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

    const byHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]));
    const ours = await this.deps.store.settlingByTx([...byHash.keys()]);
    const stages = this.stages.stagesOf(blockNumber);
    const time = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms));
    for (const row of ours) {
      const receipt = byHash.get((row.txHash ?? '').toLowerCase());
      if (!receipt) continue;
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
}
