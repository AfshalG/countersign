import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { countersignAccountAbi, orderVaultAbi } from '@countersign/chain';
import { decodeRefusal, type DecodedRefusal } from './refusals.js';
import { rpc, RpcError } from './rpc.js';
import type { Chain, Decision, PaymentCall, WebAuthnAuth } from './types.js';
import type { BlockReceipt, Head, Receipts } from './finality.js';
import type { Sender, SendOutcome } from '../relay/pool.js';
import { Pacer } from '../relay/pace.js';
import type { Payment } from '../payment.js';

type Endpoint = { url: string; sendsPerSecond: number; readsPerSecond: number };

// A paced slot can already be due (negative wait); Node warns on negative timeouts, so clamp.
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

const ALREADY_IN = /already known|known transaction|already imported|nonce too low/i;

/**
 * Monad testnet over its three public endpoints. Reads are paced so sends and reads together stay
 * under each endpoint's limit (Monad 50/s with eth_call at 15/s, Ankr 300 per 10 s, monadinfra
 * 20/s; Spike 3), and retried on rate limits and network errors. Contract refusals come back as
 * JSON-RPC error code 3 with the named error's selector as data, which decodeRefusal reads.
 */
export class MonadClient implements Chain, Sender, Receipts {
  private readonly reads: Pacer;
  private readonly started = Date.now();
  private socketOpen = false;
  private lastHeadAt = 0;

  constructor(
    private readonly endpoints: readonly Endpoint[],
    private readonly wsUrl: string,
    /** The address eth_call simulates from; any address works (signatures carry the authority). */
    private readonly simulator: Address,
  ) {
    this.reads = new Pacer(endpoints.map((e) => e.readsPerSecond));
  }

  private async read<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const slot = this.reads.take(Date.now() - this.started);
      await sleep(slot.at - (Date.now() - this.started));
      const endpoint = this.endpoints[slot.index] ?? this.endpoints[0];
      if (!endpoint) throw new Error('no endpoints configured');
      try {
        return await rpc<T>(endpoint.url, method, params);
      } catch (e) {
        if (!(e instanceof RpcError) || e.kind === 'rpc' || attempt >= 5) throw e;
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
            args: [payment, call.ownerAuth],
          });
    try {
      await this.read('eth_call', [{ from: this.simulator, to: vault, data }, 'latest']);
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
    auth: WebAuthnAuth,
  ): Promise<boolean> {
    const data = encodeFunctionData({
      abi: orderVaultAbi,
      functionName: 'recordDecisionByOwner',
      args: [decision, auth],
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
    try {
      await rpc<Hex>(target.url, 'eth_sendRawTransaction', [raw]);
      return 'accepted';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RpcError && e.kind === 'rpc')
        return ALREADY_IN.test(message) ? 'known' : { error: message, retry: false };
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
    const receipts = await this.read<{ transactionHash: Hex; status: Hex }[] | null>(
      'eth_getBlockReceipts',
      [toHex(blockNumber)],
    );
    return receipts === null
      ? null
      : receipts.map((r) => ({
          transactionHash: r.transactionHash,
          status: r.status === '0x1' ? 'success' : 'reverted',
        }));
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
