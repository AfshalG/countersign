import { keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Store } from '../db/store.js';
import { nextEndpoint, stalledNonce } from './failover.js';

export type SendOutcome = 'accepted' | 'known' | { error: string; retry: boolean };

/** Sending, as the pool needs it. The real one is src/chain/monad.ts; tests use a fake. */
export interface Sender {
  send(endpoint: number, raw: Hex): Promise<SendOutcome>;
  /** The wallet's confirmed transaction count (the `latest` nonce). */
  nonceOf(address: Address): Promise<number>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

export type Signed = { relayer: Address; nonce: number; raw: Hex; hash: Hex };

type Pending = {
  nonce: number;
  raw: Hex;
  hash: Hex;
  needsSend: boolean;
  lastAcceptedAt: number | undefined;
  error?: string;
};

type Lane = {
  account: PrivateKeyAccount;
  endpoint: number;
  chainNonce: number;
  load: number;
  lastMoveAt: number;
  pending: Map<number, Pending>;
};

export type Move = { relayer: Address; nonce: number; from: number; to: number; at: number };

export type PoolOptions = {
  keys: readonly Hex[];
  store: Store;
  sender: Sender;
  chainId: number;
  endpoints: number;
  /** A wallet's oldest pending transaction not in a finalized block this long after acceptance: move endpoint. */
  stallMs: number;
  tickMs: number;
  /** Called when an endpoint refuses a transaction for good (not a transient error). */
  onRefused?: (hash: Hex, error: string) => void;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The relayer wallets that pay gas (they never hold company money). Spike 3's findings, kept:
 * each wallet is a lane that sends its transactions in nonce order through one endpoint (a
 * wallet's later nonce reaching a node first was lost, not held); a lane whose oldest pending
 * transaction stalls moves to the next endpoint and re-sends in order, and the endpoint it
 * left is set aside for 30 s (an endpoint once accepted transactions and never forwarded them).
 */
export class RelayerPool {
  private readonly lanes: Lane[];
  private readonly setAsideUntil: number[];
  private readonly moveLog: Move[] = [];
  private running = false;
  private feeCache:
    { at: number; value: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } } | undefined;

  constructor(private readonly options: PoolOptions) {
    if (options.keys.length === 0) throw new Error('at least one relayer key is needed');
    this.lanes = options.keys.map((key, i) => ({
      account: privateKeyToAccount(key),
      endpoint: i % options.endpoints,
      chainNonce: 0,
      load: 0,
      lastMoveAt: 0,
      pending: new Map(),
    }));
    this.setAsideUntil = Array.from({ length: options.endpoints }, () => 0);
  }

  get relayers(): Address[] {
    return this.lanes.map((l) => l.account.address);
  }

  async start(): Promise<void> {
    for (const lane of this.lanes)
      lane.chainNonce = await this.options.sender.nonceOf(lane.account.address);
    this.running = true;
    for (const lane of this.lanes) void this.runLane(lane);
    void this.watch();
  }

  stop(): void {
    this.running = false;
  }

  private async fees() {
    const now = Date.now();
    if (this.feeCache && now - this.feeCache.at < 5_000) return this.feeCache.value;
    const value = await this.options.sender.fees();
    this.feeCache = { at: now, value };
    return value;
  }

  /**
   * Signs a transaction with the least-loaded wallet's next nonce. With `requestId`, the signed
   * transaction is stored on that request in the same database transaction as the nonce.
   */
  async sign(tx: { to: Address; data: Hex; gas: bigint }, requestId?: string): Promise<Signed> {
    const lane = this.lanes.reduce((a, b) => (b.load < a.load ? b : a));
    lane.load++;
    try {
      const { maxFeePerGas, maxPriorityFeePerGas } = await this.fees();
      const signed = await this.options.store.signWithNextNonce(
        lane.account.address,
        lane.chainNonce,
        async (nonce) => {
          const raw = await lane.account.signTransaction({
            chainId: this.options.chainId,
            type: 'eip1559',
            to: tx.to,
            data: tx.data,
            gas: tx.gas,
            nonce,
            maxFeePerGas,
            maxPriorityFeePerGas,
            value: 0n,
          });
          return { raw, hash: keccak256(raw) };
        },
        requestId,
      );
      return {
        relayer: lane.account.address,
        nonce: signed.nonce,
        raw: signed.raw,
        hash: signed.hash,
      };
    } catch (e) {
      lane.load--;
      throw e;
    }
  }

  /** Hands a signed transaction to its wallet's lane, which sends it in nonce order. */
  enqueue(signed: Signed): void {
    const lane = this.laneOf(signed.relayer);
    if (!lane.pending.has(signed.nonce)) {
      lane.pending.set(signed.nonce, {
        nonce: signed.nonce,
        raw: signed.raw,
        hash: signed.hash,
        needsSend: true,
        lastAcceptedAt: undefined,
      });
    }
  }

  /** Re-adopts a transaction signed before a restart, so the lane sends it again (same nonce, same hash). */
  adopt(signed: Signed): void {
    this.laneOf(signed.relayer).load++;
    this.enqueue(signed);
  }

  /** The transaction is in a finalized block: stop tracking it. */
  included(hash: Hex): void {
    for (const lane of this.lanes) {
      for (const [nonce, p] of lane.pending) {
        if (p.hash === hash) {
          lane.pending.delete(nonce);
          lane.load = Math.max(0, lane.load - 1);
          if (nonce >= lane.chainNonce) lane.chainNonce = nonce + 1;
          return;
        }
      }
    }
  }

  accepted(hash: Hex): boolean {
    return this.lanes.some((l) =>
      [...l.pending.values()].some((p) => p.hash === hash && p.lastAcceptedAt !== undefined),
    );
  }

  pending(): number {
    return this.lanes.reduce((n, l) => n + l.pending.size, 0);
  }

  moves(): readonly Move[] {
    return this.moveLog;
  }

  private laneOf(relayer: Address): Lane {
    const lane = this.lanes.find((l) => l.account.address.toLowerCase() === relayer.toLowerCase());
    if (!lane) throw new Error(`unknown relayer ${relayer}`);
    return lane;
  }

  /** Sends the lane's lowest unsent nonce, one at a time, to the lane's endpoint. */
  private async runLane(lane: Lane): Promise<void> {
    while (this.running) {
      const next = [...lane.pending.values()]
        .filter((p) => p.needsSend)
        .sort((a, b) => a.nonce - b.nonce)[0];
      if (!next) {
        await sleep(this.options.tickMs);
        continue;
      }
      next.needsSend = false; // cleared first, so a failover during the send queues it again
      const endpoint = lane.endpoint;
      let outcome: SendOutcome = { error: 'not sent', retry: true };
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          outcome = await this.options.sender.send(endpoint, next.raw);
        } catch (e) {
          outcome = { error: e instanceof Error ? e.message : String(e), retry: true };
        }
        if (outcome === 'accepted' || outcome === 'known' || !outcome.retry) break;
        await sleep(50 * attempt);
      }
      if (outcome === 'accepted' || outcome === 'known') {
        next.lastAcceptedAt = Date.now();
      } else if (outcome.retry) {
        next.needsSend = true; // still transient after retries: try again on the next round
        await sleep(this.options.tickMs);
      } else {
        next.error = outcome.error;
        this.options.onRefused?.(next.hash, outcome.error);
      }
    }
  }

  /** Every tick: a lane whose oldest pending transaction has stalled moves to the next endpoint. */
  private async watch(): Promise<void> {
    while (this.running) {
      const now = Date.now();
      for (const lane of this.lanes) {
        const records = [...lane.pending.values()]
          .filter((p) => p.error === undefined)
          .map((p) => ({
            nonce: p.nonce,
            lastAcceptedAt: p.lastAcceptedAt,
            included: false,
            failed: false,
          }));
        const stalled = stalledNonce(records, now, this.options.stallMs);
        if (stalled === undefined || now - lane.lastMoveAt < this.options.stallMs) continue;
        this.setAsideUntil[lane.endpoint] = now + 30_000;
        const to = nextEndpoint(lane.endpoint, this.setAsideUntil, now);
        this.moveLog.push({
          relayer: lane.account.address,
          nonce: stalled,
          from: lane.endpoint,
          to,
          at: now,
        });
        lane.endpoint = to;
        lane.lastMoveAt = now;
        for (const p of lane.pending.values()) {
          if (p.error !== undefined) continue;
          p.needsSend = true;
          p.lastAcceptedAt = undefined;
        }
      }
      await sleep(this.options.tickMs);
    }
  }
}
