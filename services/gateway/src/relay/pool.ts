import { formatEther, keccak256, parseTransaction, type Address, type Hex } from 'viem';
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
  /** The wallet's MON balance at `latest`, in wei. */
  balanceOf(address: Address): Promise<bigint>;
}

/** No relayer wallet can cover a transaction's maximum gas cost: the payment waits for a top-up. */
export class NoRelayerFunds extends Error {
  constructor(cost: bigint) {
    super(`no relayer can pay ${formatEther(cost)} MON of gas; top the relayers up`);
    this.name = 'NoRelayerFunds';
  }
}

/** A node refusing a transaction because its wallet cannot pay for it (Monad's reserve check). */
const SHORT_OF_GAS = /insufficient (balance|funds)/i;

/** What a transaction can cost its wallet at most: Monad charges the gas limit, and checks the maximum fee. */
const maxCostOf = (raw: Hex) => {
  const tx = parseTransaction(raw);
  return (tx.gas ?? 0n) * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n);
};

export type Signed = { relayer: Address; nonce: number; raw: Hex; hash: Hex };

type Pending = {
  nonce: number;
  raw: Hex;
  hash: Hex;
  needsSend: boolean;
  lastAcceptedAt: number | undefined;
  /** Its maximum gas cost, reserved from the wallet's balance until it is included. */
  cost: bigint;
  error?: string;
};

type Lane = {
  account: PrivateKeyAccount;
  endpoint: number;
  chainNonce: number;
  load: number;
  lastMoveAt: number;
  pending: Map<number, Pending>;
  /** MON at the last balance read, less the gas of transactions included since. */
  balance: bigint;
  /** The maximum gas cost of its signed transactions not yet included. */
  reserved: bigint;
  /** A node refused its transaction for low balance: nothing is sent until a balance read shows enough. */
  starved: boolean;
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
  /** How often wallet balances are read again (default 15 s); also how soon a topped-up wallet resumes. */
  balanceRefreshMs?: number;
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
 *
 * Gas (slice 6 testnet run, 7 Oct): a wallet is only given a transaction it can pay for at the
 * maximum fee, counting what its other unincluded transactions could cost (the check Monad's nodes
 * make). Without this the first wallet took most of the work and ran dry mid-run, and its refused
 * payment sat in `settling`. A transaction refused for low balance is held, not dropped, and sent
 * again unchanged once a balance read shows the wallet can pay: same nonce, same hash, never twice.
 */
export class RelayerPool {
  private readonly lanes: Lane[];
  private readonly setAsideUntil: number[];
  private readonly moveLog: Move[] = [];
  private running = false;
  private lastRefreshAt = 0;
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
      balance: 0n,
      reserved: 0n,
      starved: false,
    }));
    this.setAsideUntil = Array.from({ length: options.endpoints }, () => 0);
  }

  get relayers(): Address[] {
    return this.lanes.map((l) => l.account.address);
  }

  async start(): Promise<void> {
    for (const lane of this.lanes)
      lane.chainNonce = await this.options.sender.nonceOf(lane.account.address);
    await this.refreshBalances();
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

  /** Reads every wallet's balance; a starved wallet that can now pay resumes sending. */
  async refreshBalances(): Promise<void> {
    this.lastRefreshAt = Date.now();
    for (const lane of this.lanes) {
      lane.balance = await this.options.sender.balanceOf(lane.account.address);
      if (lane.starved && lane.balance >= lane.reserved) {
        lane.starved = false;
        for (const p of lane.pending.values()) {
          if (p.error === undefined || !SHORT_OF_GAS.test(p.error)) continue;
          delete p.error;
          p.needsSend = true;
          p.lastAcceptedAt = undefined;
        }
      }
    }
  }

  /** Wallets waiting for a top-up, for /health. */
  starved(): Address[] {
    return this.lanes.filter((l) => l.starved).map((l) => l.account.address);
  }

  /** The least-loaded wallet that can cover `cost`; on a tie, the one with the most left. */
  private pick(cost: bigint): Lane {
    const room = (l: Lane) => l.balance - l.reserved;
    const able = this.lanes.filter((l) => !l.starved && room(l) >= cost);
    const first = able[0];
    if (!first) throw new NoRelayerFunds(cost);
    return able.reduce(
      (a, b) => (b.load < a.load || (b.load === a.load && room(b) > room(a)) ? b : a),
      first,
    );
  }

  /**
   * Signs a transaction with the next nonce of the least-loaded wallet that can pay for it. With
   * `requestId`, the signed transaction is stored on that request in the same database transaction
   * as the nonce. Throws NoRelayerFunds when no wallet can pay; the request stays released.
   */
  async sign(tx: { to: Address; data: Hex; gas: bigint }, requestId?: string): Promise<Signed> {
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.fees();
    const cost = tx.gas * maxFeePerGas;
    // Picked and reserved with no await in between, so concurrent signs cannot overcommit a wallet.
    const lane = this.pick(cost);
    lane.load++;
    lane.reserved += cost;
    try {
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
      lane.reserved -= cost;
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
        cost: maxCostOf(signed.raw), // reserved when it was signed
      });
    }
  }

  /** Re-adopts a transaction signed before a restart, so the lane sends it again (same nonce, same hash). */
  adopt(signed: Signed): void {
    const lane = this.laneOf(signed.relayer);
    if (lane.pending.has(signed.nonce)) return;
    lane.load++;
    lane.reserved += maxCostOf(signed.raw);
    this.enqueue(signed);
  }

  /** The transaction is in a finalized block: stop tracking it. */
  included(hash: Hex): void {
    for (const lane of this.lanes) {
      for (const [nonce, p] of lane.pending) {
        if (p.hash === hash) {
          lane.pending.delete(nonce);
          lane.load = Math.max(0, lane.load - 1);
          lane.reserved -= p.cost;
          // Counted as spent at the maximum; the next balance read replaces the estimate.
          lane.balance -= p.cost;
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
      if (lane.starved) {
        await sleep(this.options.tickMs);
        continue;
      }
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
        if (SHORT_OF_GAS.test(outcome.error)) lane.starved = true;
        this.options.onRefused?.(next.hash, outcome.error);
      }
    }
  }

  /** Every tick: a lane whose oldest pending transaction has stalled moves to the next endpoint. */
  private async watch(): Promise<void> {
    while (this.running) {
      const now = Date.now();
      if (now - this.lastRefreshAt >= (this.options.balanceRefreshMs ?? 15_000)) {
        // A failed read keeps the last balances until the next interval.
        await this.refreshBalances().catch(() => undefined);
      }
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
