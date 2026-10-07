import { encodeFunctionData, erc20Abi, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { USDC } from '@countersign/chain';
import type { Sender } from '../relay/pool.js';
import type { Funder } from './accounts.js';

/** A USDC transfer used 90k–109k gas in Slice 5's broadcast; Monad charges the limit. */
export const TRANSFER_GAS = 120_000n;

/**
 * The wallet that funds demo accounts with test USDC. Kept apart from the relayers, which pay gas
 * but never hold money, and holding only what judge mode needs, so its key on the server risks
 * little. Transfers go out one at a time with nonces counted here; a refused send makes it read
 * its nonce from the chain again.
 */
export class WalletFunder implements Funder {
  private readonly account: PrivateKeyAccount;
  private nonce: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    key: Hex,
    private readonly chain: Pick<Sender, 'send' | 'nonceOf' | 'fees'>,
    private readonly chainId: number,
  ) {
    this.account = privateKeyToAccount(key);
  }

  get address(): Address {
    return this.account.address;
  }

  sendUsdc(to: Address, amount: bigint): Promise<Hex> {
    const run = this.queue.then(async () => {
      this.nonce ??= await this.chain.nonceOf(this.account.address);
      const { maxFeePerGas, maxPriorityFeePerGas } = await this.chain.fees();
      const raw = await this.account.signTransaction({
        chainId: this.chainId,
        type: 'eip1559',
        to: USDC,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
        gas: TRANSFER_GAS,
        nonce: this.nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
        value: 0n,
      });
      const outcome = await this.chain.send(0, raw);
      if (outcome !== 'accepted' && outcome !== 'known') {
        this.nonce = undefined;
        throw new Error(`the funding transfer was refused: ${outcome.error}`);
      }
      this.nonce++;
      return keccak256(raw);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
