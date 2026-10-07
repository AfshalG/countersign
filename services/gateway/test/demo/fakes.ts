import {
  concat,
  decodeFunctionData,
  getAddress,
  keccak256,
  slice,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { accountFactoryAbi } from '@countersign/chain';
import type { Store } from '../../src/db/store.js';
import type { DemoChain, DemoDeps } from '../../src/demo/accounts.js';

export const CHAIN_ID = 10143;
export const FACTORY: Address = '0x094250cCC1dDBd8530e4FC9A1C900db3D0D9EB5f';
export const AGENT: Address = '0x2222222222222222222222222222222222222222';
export const CHECKER: Address = '0x3333333333333333333333333333333333333333';

/** Monad as judge mode sees it: accounts, owner nonces and USDC balances, changed by what is sent. */
export class FakeDemoChain implements DemoChain {
  code = new Set<string>();
  nonces = new Map<string, bigint>();
  usdc = new Map<string, bigint>();
  invalidKey = false;
  ownerKeyValid = true;
  dryRuns = 0;
  predictAccount(qx: Hex, qy: Hex): Promise<Address> {
    return Promise.resolve(getAddress(slice(keccak256(concat([qx, qy])), 12)));
  }
  hasCode(a: Address) {
    return Promise.resolve(this.code.has(a.toLowerCase()));
  }
  ownerNonce(a: Address) {
    return Promise.resolve(this.nonces.get(a.toLowerCase()) ?? 0n);
  }
  usdcBalance(a: Address) {
    return Promise.resolve(this.usdc.get(a.toLowerCase()) ?? 0n);
  }
  latestFinalized() {
    return Promise.resolve(1_000);
  }
  /** Receipts the chain has for transactions whose wait timed out. */
  final = new Map<string, { status: 'success' | 'reverted'; blockNumber: number }>();
  finalizedReceipt(hash: Hex) {
    return Promise.resolve(this.final.get(hash) ?? null);
  }
  dryRun(to: Address): Promise<string | undefined> {
    this.dryRuns++;
    if (to === FACTORY) return Promise.resolve(this.invalidKey ? 'InvalidOwnerKey' : undefined);
    return Promise.resolve(this.ownerKeyValid ? undefined : 'InvalidOwnerSignature');
  }
}

/**
 * Judge-mode dependencies on a fake chain: the fake pool records each transaction and applies its
 * effect as Monad would (the account exists, or its owner nonce moves); the funder credits USDC.
 */
export function demoDeps(store: Store) {
  const chain = new FakeDemoChain();
  const sent: { to: Address; data: Hex; gas: bigint }[] = [];
  const funded: { to: Address; amount: bigint }[] = [];
  let n = 0;
  const deps: DemoDeps = {
    store,
    chain,
    pool: {
      sign: async (tx) => {
        n++;
        sent.push(tx);
        if (tx.to === FACTORY) {
          const { args } = decodeFunctionData({ abi: accountFactoryAbi, data: tx.data });
          const [qx, qy] = args as unknown as [Hex, Hex];
          chain.code.add((await chain.predictAccount(qx, qy)).toLowerCase());
        } else {
          const key = tx.to.toLowerCase();
          chain.nonces.set(key, (chain.nonces.get(key) ?? 0n) + 1n);
        }
        return { relayer: AGENT, nonce: n, raw: '0x02', hash: keccak256(toHex(`tx ${String(n)}`)) };
      },
      enqueue: () => undefined,
    },
    finality: { waitFinal: () => Promise.resolve({ status: 'success', blockNumber: 1_001 }) },
    funder: {
      sendUsdc: (to, amount) => {
        funded.push({ to, amount });
        chain.usdc.set(to.toLowerCase(), (chain.usdc.get(to.toLowerCase()) ?? 0n) + amount);
        return Promise.resolve(keccak256(toHex(`usdc ${to}`)));
      },
    },
    chainId: CHAIN_ID,
    factory: FACTORY,
    agentKey: AGENT,
    checkerKey: CHECKER,
    perDay: 20,
  };
  return { deps, chain, sent, funded };
}
