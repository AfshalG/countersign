import {
  decodeFunctionData,
  encodeErrorResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from 'viem';
import { orderVaultAbi } from '@countersign/chain';
import type { Chain, PaymentCall } from '../src/chain/types.js';
import { decodeRefusal, type DecodedRefusal } from '../src/chain/refusals.js';
import type { BlockReceipt, Head, Receipts } from '../src/chain/finality.js';
import type { Payment } from '../src/payment.js';
import type { Sender, SendOutcome } from '../src/relay/pool.js';

/**
 * A small Monad: a mempool, a block every `intervalMs` that includes each wallet's transactions
 * in nonce order (a wallet's later nonce waits for the earlier one), receipts per block, and the
 * Proposed, Voted and Finalized heads. A vault pays an invoice once; a second transaction for the
 * same invoice reverts, as AlreadyPaid does on chain. `paid` counts payments per invoice.
 */
export class FakeMonad implements Chain, Sender, Receipts {
  readonly paid = new Map<string, number>();
  /** The supplier's address on file: the vault refuses any other (PayToNotOnFile). */
  onFile: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
  readonly sentHashes = new Set<Hex>();
  onHead: (head: Head) => void = () => undefined;
  private readonly confirmed = new Map<string, number>();
  private readonly mempool = new Map<string, Map<number, Hex>>();
  private readonly receipts = new Map<number, BlockReceipt[]>();
  private readonly byHash = new Map<
    string,
    { status: 'success' | 'reverted'; blockNumber: number }
  >();
  private block = 1_000;
  private timer: ReturnType<typeof setInterval> | undefined;

  // ---------- Chain ----------

  simulate(
    _vault: Address,
    payment: Payment,
    call: PaymentCall,
  ): Promise<DecodedRefusal | undefined> {
    const refuse = (errorName: 'InvalidCheckerSignature' | 'AlreadyPaid' | 'PayToNotOnFile') =>
      Promise.resolve(decodeRefusal(encodeErrorResult({ abi: orderVaultAbi, errorName })));
    if (payment.payTo.toLowerCase() !== this.onFile.toLowerCase()) return refuse('PayToNotOnFile');
    if ((this.paid.get(payment.invoiceHash) ?? 0) > 0) return refuse('AlreadyPaid');
    if (call.kind === 'pay' && call.checkerSig === '0x') return refuse('InvalidCheckerSignature');
    return Promise.resolve(undefined);
  }

  orderState(): Promise<{
    remaining: bigint;
    payTo: Address;
    supplierActive: boolean;
    activeAfter: number;
  }> {
    return Promise.resolve({
      remaining: 30_000n,
      payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEc',
      supplierActive: true,
      activeAfter: 0,
    });
  }

  addressOnFile(): Promise<Address> {
    return Promise.resolve(this.onFile);
  }

  verifyOwnerDecision(): Promise<boolean> {
    return Promise.resolve(true);
  }

  owners(): Promise<{ qx: Hex; qy: Hex }[]> {
    return Promise.resolve([{ qx: `0x${'11'.repeat(32)}`, qy: `0x${'22'.repeat(32)}` }]);
  }

  finalizedReceipt(
    hash: Hex,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number } | null> {
    return Promise.resolve(this.byHash.get(hash.toLowerCase()) ?? null);
  }

  // ---------- Sender ----------

  async send(_endpoint: number, raw: Hex): Promise<SendOutcome> {
    const from = (
      await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })
    ).toLowerCase();
    const nonce = parseTransaction(raw).nonce ?? 0;
    if (nonce < (this.confirmed.get(from) ?? 0)) return 'known';
    const pool = this.mempool.get(from) ?? new Map<number, Hex>();
    if (pool.has(nonce)) return 'known';
    pool.set(nonce, raw);
    this.mempool.set(from, pool);
    this.sentHashes.add(keccak256(raw));
    return 'accepted';
  }

  nonceOf(address: Address): Promise<number> {
    return Promise.resolve(this.confirmed.get(address.toLowerCase()) ?? 0);
  }

  /** 10 MON for every wallet: the fake chain never runs a relayer dry. */
  balanceOf(): Promise<bigint> {
    return Promise.resolve(10n ** 19n);
  }

  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    return Promise.resolve({
      maxFeePerGas: 127_500_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
  }

  // ---------- Receipts ----------

  blockReceipts(n: number): Promise<BlockReceipt[] | null> {
    return Promise.resolve(this.receipts.get(n) ?? (n <= this.block ? [] : null));
  }

  latestFinalized(): Promise<number> {
    return Promise.resolve(this.block);
  }

  // ---------- blocks ----------

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      this.produce();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private produce(): void {
    const number = ++this.block;
    const list: BlockReceipt[] = [];
    for (const [from, pool] of this.mempool) {
      let next = this.confirmed.get(from) ?? 0;
      for (let raw = pool.get(next); raw !== undefined; raw = pool.get(next)) {
        pool.delete(next);
        const receipt = { transactionHash: keccak256(raw), status: this.execute(raw) };
        list.push(receipt);
        this.byHash.set(receipt.transactionHash.toLowerCase(), {
          status: receipt.status,
          blockNumber: number,
        });
        next++;
      }
      this.confirmed.set(from, next);
    }
    this.receipts.set(number, list);
    const id = `0xb${String(number)}`;
    const at = Date.now();
    this.onHead({ number, blockId: id, commitState: 'Proposed', at });
    this.onHead({ number, blockId: id, commitState: 'Voted', at: at + 1 });
    this.onHead({ number, blockId: id, commitState: 'Finalized', at: at + 2 });
  }

  private execute(raw: Hex): 'success' | 'reverted' {
    const tx = parseTransaction(raw);
    let call;
    try {
      call = decodeFunctionData({ abi: orderVaultAbi, data: tx.data ?? '0x' });
    } catch {
      return 'success'; // not a vault call (judge-mode setup, a factory call): it simply runs
    }
    if (call.functionName !== 'pay' && call.functionName !== 'payWithOwner') return 'success';
    const invoice = (call.args[0] as { invoiceHash: Hex }).invoiceHash;
    const times = this.paid.get(invoice) ?? 0;
    if (times > 0) return 'reverted'; // AlreadyPaid
    this.paid.set(invoice, times + 1);
    return 'success';
  }
}
