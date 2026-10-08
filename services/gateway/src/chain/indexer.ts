import { decodeEventLog, getAddress, type Address, type Hex } from 'viem';
import { countersignAccountAbi } from '@countersign/chain';
import type { Store } from '../db/store.js';

/** One log as the indexer needs it (from a block's receipts or from eth_getLogs). */
export type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: number };

/** Reading logs, as the indexer needs it. The real one is src/chain/monad.ts. */
export interface LogSource {
  /** Order events of these accounts in [fromBlock, toBlock], within one endpoint's range limit. */
  logs(addresses: Address[], fromBlock: number, toBlock: number): Promise<RawLog[]>;
  latestFinalized(): Promise<number>;
}

/**
 * Keeps the `orders` table in step with each registered account's `OrderApproved` and
 * `OrderClosed` events, from finalized blocks only (Slice 12, S12-6).
 *
 * The finality tracker already reads every finalized block's receipts, so new blocks cost
 * nothing extra (`onBlock`). An account is advanced only block by block: one that is behind (just
 * registered, or the gateway was down) is left to `catchUp`, which reads its logs from its saved
 * block in windows within Monad's eth_getLogs limit (100 blocks on Monad's endpoint, 1,000 on
 * Ankr). Applying an event twice changes nothing, so a replay after a crash is safe.
 */
export class OrderIndexer {
  private running: Promise<void> | undefined;

  constructor(private readonly deps: { store: Store; source: LogSource; windowBlocks?: number }) {}

  /** A finalized block's logs, in order. */
  async onBlock(blockNumber: number, logs: readonly RawLog[]): Promise<void> {
    for (const account of await this.deps.store.listAccounts()) {
      if (account.indexedTo !== blockNumber - 1) continue; // behind: catchUp; ahead: done
      const address = account.address as Address;
      for (const log of logs)
        if (log.address.toLowerCase() === address.toLowerCase()) await this.apply(address, log);
      await this.deps.store.setIndexedTo(address, blockNumber);
    }
  }

  /** Brings every account up to the latest finalized block. Concurrent calls share one run. */
  catchUp(): Promise<void> {
    this.running ??= this.catchUpOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async catchUpOnce(): Promise<void> {
    const window = this.deps.windowBlocks ?? 100;
    const target = await this.deps.source.latestFinalized();
    for (const account of await this.deps.store.listAccounts()) {
      const address = account.address as Address;
      for (let from = account.indexedTo + 1; from <= target; from += window) {
        const to = Math.min(from + window - 1, target);
        const logs = await this.deps.source.logs([address], from, to);
        logs.sort((a, b) => a.blockNumber - b.blockNumber);
        for (const log of logs) await this.apply(address, log);
        await this.deps.store.setIndexedTo(address, to);
      }
    }
  }

  private async apply(account: Address, log: RawLog): Promise<void> {
    let event;
    try {
      event = decodeEventLog({
        abi: countersignAccountAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      return; // not one of the account's events
    }
    if (event.eventName === 'OrderApproved') {
      await this.deps.store.upsertOrder({
        vault: getAddress(event.args.vault),
        account,
        orderId: event.args.orderId,
        supplierId: event.args.supplierId,
        orderHash: event.args.orderHash,
        amount: event.args.amount.toString(),
        expiry: Number(event.args.expiry),
        approvedBlock: log.blockNumber,
      });
    } else if (event.eventName === 'OrderClosed') {
      await this.deps.store.closeOrder(getAddress(event.args.vault));
    }
  }
}
