import {
  decodeErrorResult,
  decodeFunctionResult,
  erc20Abi,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import {
  accountFactoryAbi,
  countersignAccountAbi,
  deployments,
  identityRegistryAbi,
  orderVaultAbi,
  USDC,
} from '@countersign/chain';
import { decodeRefusal, type DecodedRefusal } from './refusals.js';
import { rpc, RpcError } from './rpc.js';
import type { Chain, Decision, OwnerKey, OwnerSig, PaymentCall } from './types.js';
import type { BlockReceipt, Head, Receipts } from './finality.js';
import type { LogSource, RawLog } from './indexer.js';
import type { Sender, SendOutcome } from '../relay/pool.js';
import { Pacer } from '../relay/pace.js';
import type { Payment } from '../payment.js';
import type { DemoChain } from '../demo/accounts.js';
import type { ProposalChain } from '../owner/proposals.js';
import type { PauseChain } from '../owner/pause.js';
import type { IdentityChain } from '../agents/identity.js';
import { IDENTITY_REGISTRY_TESTNET } from '@countersign/shared';

type Endpoint = { url: string; sendsPerSecond: number; readsPerSecond: number };

// A paced slot can already be due (negative wait); Node warns on negative timeouts, so clamp.
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

const ALREADY_IN = /already known|known transaction|already imported|nonce too low/i;
/**
 * A node asking to slow down inside a JSON-RPC answer (Monad: -32007 "50/second request limit
 * reached", -32011 "requests limited to 15/sec"): a reason to wait and try again, never a refusal
 * (Slice 16: treated as one, it abandoned a wallet's lowest transaction and stuck its lane).
 */
const RATE_LIMITED = /request limit|requests limited|rate limit|too many requests/i;

/** The account events the order indexer reads: OrderApproved and OrderClosed. */
const ORDER_EVENTS: Hex[] = (['OrderApproved', 'OrderClosed'] as const).map(
  (eventName) => encodeEventTopics({ abi: countersignAccountAbi, eventName })[0],
);

/**
 * Monad testnet over its three public endpoints. Reads are paced so sends and reads together stay
 * under each endpoint's limit (Monad 50/s with eth_call at 15/s, Ankr 300 per 10 s, monadinfra
 * 20/s; Spike 3), and retried on rate limits and network errors. Contract refusals come back as
 * JSON-RPC error code 3 with the named error's selector as data, which decodeRefusal reads.
 */
export class MonadClient
  implements Chain, Sender, Receipts, LogSource, DemoChain, ProposalChain, PauseChain, IdentityChain
{
  /** Everything but payment simulations: receipts, blocks, nonces, an owner's dry runs. */
  private readonly reads: Pacer;
  /**
   * Payment simulations, the bulk of a run (Slice 16): their own share of each endpoint's budget,
   * so a burst of checks never starves the finality tracker (in the first fast run of 200, 149
   * payments sat sent but not marked final until the checks were done).
   */
  private readonly simulations: Pacer;
  /** When each endpoint can take its next send (Slice 16: sends were not paced at all). */
  private readonly nextSend: number[];
  private readonly started = Date.now();
  private socketOpen = false;
  private lastHeadAt = 0;

  constructor(
    private readonly endpoints: readonly Endpoint[],
    private readonly wsUrl: string,
    /** The address eth_call simulates from; any address works (signatures carry the authority). */
    private readonly simulator: Address,
  ) {
    // A quarter of each endpoint's read budget (at least 2 a second) for everything but payment
    // simulations; the rest for those.
    const kept = endpoints.map((e) => Math.max(2, Math.round(e.readsPerSecond / 4)));
    this.reads = new Pacer(kept);
    this.simulations = new Pacer(
      endpoints.map((e, i) => Math.max(1, e.readsPerSecond - (kept[i] as number))),
    );
    this.nextSend = endpoints.map(() => 0);
  }

  private async read<T>(method: string, params: unknown[], pacer = this.reads): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const slot = pacer.take(Date.now() - this.started);
      await sleep(slot.at - (Date.now() - this.started));
      const endpoint = this.endpoints[slot.index] ?? this.endpoints[0];
      if (!endpoint) throw new Error('no endpoints configured');
      try {
        return await rpc<T>(endpoint.url, method, params);
      } catch (e) {
        const slowDown = e instanceof RpcError && e.kind === 'rpc' && RATE_LIMITED.test(e.message);
        if (!(e instanceof RpcError) || (e.kind === 'rpc' && !slowDown) || attempt >= 5) throw e;
        await sleep(150 * attempt);
      }
    }
  }

  // ---------- Chain ----------

  async simulate(
    vault: Address,
    payment: Payment,
    call: PaymentCall,
  ): Promise<DecodedRefusal | undefined> {
    const data =
      call.kind === 'pay'
        ? encodeFunctionData({
            abi: orderVaultAbi,
            functionName: 'pay',
            args: [payment, call.agentSig, call.checkerSig],
          })
        : encodeFunctionData({
            abi: orderVaultAbi,
            functionName: 'payWithOwner',
            args: [payment, call.ownerSigs],
          });
    try {
      await this.read(
        'eth_call',
        [{ from: this.simulator, to: vault, data }, 'latest'],
        this.simulations,
      );
      return undefined;
    } catch (e) {
      if (e instanceof RpcError && e.kind === 'rpc' && e.data !== undefined)
        return decodeRefusal(e.data);
      throw e;
    }
  }

  private async call(to: Address, data: Hex): Promise<Hex> {
    return this.read<Hex>('eth_call', [{ from: this.simulator, to, data }, 'latest']);
  }

  // ---------- judge mode (DemoChain) ----------

  async predictAccount(qx: Hex, qy: Hex, waitingPeriod: bigint, salt: Hex): Promise<Address> {
    const args = [qx, qy, waitingPeriod, salt] as const;
    const out = await this.call(
      deployments.accountFactory,
      encodeFunctionData({ abi: accountFactoryAbi, functionName: 'predictAccount', args }),
    );
    return decodeFunctionResult({
      abi: accountFactoryAbi,
      functionName: 'predictAccount',
      data: out,
    });
  }

  async hasCode(address: Address): Promise<boolean> {
    const code = await this.read<Hex>('eth_getCode', [address, 'latest']);
    return code.length > 2;
  }

  async ownerNonce(account: Address): Promise<bigint> {
    const out = await this.call(
      account,
      encodeFunctionData({ abi: countersignAccountAbi, functionName: 'ownerNonce' }),
    );
    return decodeFunctionResult({
      abi: countersignAccountAbi,
      functionName: 'ownerNonce',
      data: out,
    });
  }

  async supplierOf(
    account: Address,
    supplierId: Hex,
  ): Promise<{ payTo: Address; active: boolean; activeAfter: number } | null> {
    const out = await this.call(
      account,
      encodeFunctionData({
        abi: countersignAccountAbi,
        functionName: 'supplier',
        args: [supplierId],
      }),
    );
    const s = decodeFunctionResult({
      abi: countersignAccountAbi,
      functionName: 'supplier',
      data: out,
    });
    if (/^0x0{40}$/i.test(s.payTo)) return null; // never set
    return { payTo: getAddress(s.payTo), active: s.active, activeAfter: Number(s.activeAfter) };
  }

  /** ERC-8004: an agent's wallet in the Identity Registry; rejects if the agent does not exist. */
  async agentWallet(agentId: bigint): Promise<Address> {
    // getAgentWallet answers zero for an id never minted; ownerOf is what rejects it.
    await this.call(
      IDENTITY_REGISTRY_TESTNET,
      encodeFunctionData({ abi: identityRegistryAbi, functionName: 'ownerOf', args: [agentId] }),
    );
    const out = await this.call(
      IDENTITY_REGISTRY_TESTNET,
      encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: 'getAgentWallet',
        args: [agentId],
      }),
    );
    return decodeFunctionResult({
      abi: identityRegistryAbi,
      functionName: 'getAgentWallet',
      data: out,
    });
  }

  async paused(account: Address): Promise<boolean> {
    const out = await this.call(
      account,
      encodeFunctionData({ abi: countersignAccountAbi, functionName: 'paused' }),
    );
    return decodeFunctionResult({ abi: countersignAccountAbi, functionName: 'paused', data: out });
  }

  async effectiveWaitingPeriod(account: Address): Promise<number> {
    const out = await this.call(
      account,
      encodeFunctionData({ abi: countersignAccountAbi, functionName: 'effectiveWaitingPeriod' }),
    );
    return Number(
      decodeFunctionResult({
        abi: countersignAccountAbi,
        functionName: 'effectiveWaitingPeriod',
        data: out,
      }),
    );
  }

  async ownership(
    account: Address,
  ): Promise<{ owners: OwnerKey[]; manage: number; release: number }> {
    const read = (functionName: 'owners' | 'manageThreshold' | 'releaseThreshold') =>
      this.call(account, encodeFunctionData({ abi: countersignAccountAbi, functionName }));
    const [owners, manage, release] = await Promise.all([
      read('owners'),
      read('manageThreshold'),
      read('releaseThreshold'),
    ]);
    return {
      owners: decodeFunctionResult({
        abi: countersignAccountAbi,
        functionName: 'owners',
        data: owners,
      }).map((k) => ({ qx: k.qx, qy: k.qy })),
      manage: decodeFunctionResult({
        abi: countersignAccountAbi,
        functionName: 'manageThreshold',
        data: manage,
      }),
      release: decodeFunctionResult({
        abi: countersignAccountAbi,
        functionName: 'releaseThreshold',
        data: release,
      }),
    };
  }

  async usdcBalance(address: Address): Promise<bigint> {
    const out = await this.call(
      USDC,
      encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    );
    return decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: out });
  }

  /** A factory or account call as an eth_call: undefined if it would succeed, else the error name. */
  async dryRun(to: Address, data: Hex): Promise<string | undefined> {
    try {
      await this.call(to, data);
      return undefined;
    } catch (e) {
      if (!(e instanceof RpcError) || e.kind !== 'rpc') throw e;
      if (e.data === undefined) return 'unknown';
      try {
        return decodeErrorResult({
          abi: [...accountFactoryAbi, ...countersignAccountAbi],
          data: e.data,
        }).errorName;
      } catch {
        return 'unknown';
      }
    }
  }

  async addressOnFile(account: Address, vault: Address): Promise<Address> {
    const supplierId = decodeFunctionResult({
      abi: orderVaultAbi,
      functionName: 'supplierId',
      data: await this.call(
        vault,
        encodeFunctionData({ abi: orderVaultAbi, functionName: 'supplierId' }),
      ),
    });
    const supplier = decodeFunctionResult({
      abi: countersignAccountAbi,
      functionName: 'supplier',
      data: await this.call(
        account,
        encodeFunctionData({
          abi: countersignAccountAbi,
          functionName: 'supplier',
          args: [supplierId],
        }),
      ),
    });
    return getAddress(supplier.payTo);
  }

  async verifyOwnerDecision(
    vault: Address,
    decision: Decision,
    sigs: OwnerSig[],
  ): Promise<boolean> {
    const data = encodeFunctionData({
      abi: orderVaultAbi,
      functionName: 'recordDecisionByOwner',
      args: [decision, sigs],
    });
    try {
      await this.read('eth_call', [{ from: this.simulator, to: vault, data }, 'latest']);
      return true;
    } catch (e) {
      if (e instanceof RpcError && e.kind === 'rpc') return false;
      throw e;
    }
  }

  async finalizedReceipt(
    hash: Hex,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null> {
    const receipt = await this.read<{ status: Hex; blockNumber: Hex } | null>(
      'eth_getTransactionReceipt',
      [hash],
    );
    if (receipt === null) return null;
    const blockNumber = Number(receipt.blockNumber);
    if (blockNumber > (await this.latestFinalized())) return null;
    return { status: receipt.status === '0x1' ? 'success' : 'reverted', blockNumber };
  }

  // ---------- Sender ----------

  async send(endpoint: number, raw: Hex): Promise<SendOutcome> {
    const target = this.endpoints[endpoint];
    if (!target) return { error: `no endpoint ${String(endpoint)}`, retry: false };
    // Each endpoint's sends are paced to its budget, which leaves room for the reads under its limit.
    const now = Date.now() - this.started;
    const at = Math.max(now, this.nextSend[endpoint] ?? 0);
    this.nextSend[endpoint] = at + 1000 / target.sendsPerSecond;
    await sleep(at - now);
    try {
      await rpc<Hex>(target.url, 'eth_sendRawTransaction', [raw]);
      return 'accepted';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RpcError && e.kind === 'rate')
        return { error: message, retry: true, rateLimited: true };
      if (e instanceof RpcError && e.kind === 'rpc') {
        if (ALREADY_IN.test(message)) return 'known';
        if (RATE_LIMITED.test(message)) return { error: message, retry: true, rateLimited: true };
        return { error: message, retry: false };
      }
      return { error: message, retry: true };
    }
  }

  async nonceOf(address: Address): Promise<number> {
    return Number(await this.read<Hex>('eth_getTransactionCount', [address, 'latest']));
  }

  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.read<{ baseFeePerGas?: Hex }>('eth_getBlockByNumber', [
      'latest',
      false,
    ]);
    const base = block.baseFeePerGas !== undefined ? BigInt(block.baseFeePerGas) : 100_000_000_000n;
    const tip = 2_000_000_000n;
    // A quarter above the base fee: room for it to rise without bidding more of the wallet's reserve budget than needed.
    return { maxFeePerGas: (base * 5n) / 4n + tip, maxPriorityFeePerGas: tip };
  }

  async balanceOf(address: Address): Promise<bigint> {
    return BigInt(await this.read<Hex>('eth_getBalance', [address, 'latest']));
  }

  // ---------- Receipts ----------

  async blockReceipts(blockNumber: number): Promise<BlockReceipt[] | null> {
    const receipts = await this.read<
      | {
          transactionHash: Hex;
          status: Hex;
          logs?: { address: Address; topics: Hex[]; data: Hex }[];
        }[]
      | null
    >('eth_getBlockReceipts', [toHex(blockNumber)]);
    return receipts === null
      ? null
      : receipts.map((r) => ({
          transactionHash: r.transactionHash,
          status: r.status === '0x1' ? 'success' : 'reverted',
          logs: (r.logs ?? []).map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber,
          })),
        }));
  }

  // ---------- LogSource ----------

  /**
   * The accounts' order events in [fromBlock, toBlock]. Callers keep ranges within 100 blocks,
   * Monad's own endpoint's eth_getLogs limit (Ankr allows 1,000).
   */
  async logs(addresses: Address[], fromBlock: number, toBlock: number): Promise<RawLog[]> {
    const found = await this.read<
      { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex }[]
    >('eth_getLogs', [
      {
        address: addresses,
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
        topics: [ORDER_EVENTS],
      },
    ]);
    return found.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: Number(l.blockNumber),
    }));
  }

  // ---------- orders ----------

  /** What is left in an order and its supplier's record, read live (never stored). */
  async orderState(
    account: Address,
    vault: Address,
    supplierId: Hex,
  ): Promise<{ remaining: bigint; payTo: Address; supplierActive: boolean; activeAfter: number }> {
    const [remainingData, supplierData] = await Promise.all([
      this.call(vault, encodeFunctionData({ abi: orderVaultAbi, functionName: 'remaining' })),
      this.call(
        account,
        encodeFunctionData({
          abi: countersignAccountAbi,
          functionName: 'supplier',
          args: [supplierId],
        }),
      ),
    ]);
    const supplier = decodeFunctionResult({
      abi: countersignAccountAbi,
      functionName: 'supplier',
      data: supplierData,
    });
    return {
      remaining: decodeFunctionResult({
        abi: orderVaultAbi,
        functionName: 'remaining',
        data: remainingData,
      }),
      payTo: getAddress(supplier.payTo),
      supplierActive: supplier.active,
      activeAfter: Number(supplier.activeAfter),
    };
  }

  async latestFinalized(): Promise<number> {
    const block = await this.read<{ number: Hex }>('eth_getBlockByNumber', ['finalized', false]);
    return Number(block.number);
  }

  // ---------- block stages ----------

  socketState() {
    return {
      open: this.socketOpen,
      lastHeadMsAgo: this.lastHeadAt === 0 ? null : Date.now() - this.lastHeadAt,
    };
  }

  /** Follows monadNewHeads, reconnecting after a drop (the finality tracker reads any blocks it missed). */
  subscribeHeads(onHead: (head: Head) => void): { close: () => void } {
    let closed = false;
    let socket: WebSocket | undefined;
    const open = () => {
      const ws = new WebSocket(this.wsUrl);
      socket = ws;
      ws.onopen = () => {
        this.socketOpen = true;
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_subscribe',
            params: ['monadNewHeads'],
          }),
        );
      };
      ws.onmessage = (event: MessageEvent) => {
        const at = Date.now();
        let message: {
          params?: { result?: { number?: string; blockId?: string; commitState?: string } };
        };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          return;
        }
        const head = message.params?.result;
        if (
          head?.number === undefined ||
          head.blockId === undefined ||
          head.commitState === undefined
        )
          return;
        this.lastHeadAt = at;
        onHead({
          number: Number.parseInt(head.number, 16),
          blockId: head.blockId,
          commitState: head.commitState,
          at,
        });
      };
      ws.onerror = () => {
        // onclose follows and reconnects
      };
      ws.onclose = () => {
        this.socketOpen = false;
        if (!closed) {
          setTimeout(open, 500);
        }
      };
    };
    open();
    return {
      close: () => {
        closed = true;
        socket?.close();
      },
    };
  }
}
