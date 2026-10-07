import { getAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { agentRegistryId, paymentTypes, vaultDomain } from '@countersign/shared';
import type { Store } from '../db/store.js';

/**
 * Which agent signed a payment (Slice 19). Every payment carries the agent's signature in the
 * vault's EIP-712 domain; the address it recovers to is public, in the transaction itself. When
 * that address is an agent's `agentWallet` in the ERC-8004 Identity Registry, the payment belongs
 * to that registered agent, and anyone can check it on chain. Nothing about the vaults changes.
 */

/** The address a payment's agent signature recovers to; null if it does not recover. */
export async function recoverAgent(
  chainId: number,
  vault: Address,
  payment: { amount: bigint; invoiceHash: Hex; payTo: Address; deadline: bigint },
  agentSig: Hex,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      domain: vaultDomain(chainId, vault),
      types: paymentTypes,
      primaryType: 'Payment',
      message: payment,
      signature: agentSig,
    });
  } catch {
    return null;
  }
}

/** What the directory reads from the Identity Registry. The real one is src/chain/monad.ts. */
export interface IdentityChain {
  /** `getAgentWallet(agentId)`; rejects if the agent does not exist. */
  agentWallet(agentId: bigint): Promise<Address>;
}

export type AgentIdentity = { agentId: string; registry: string; wallet: Address };

/**
 * The ERC-8004 agents the gateway names, by wallet address, kept in memory for the payment
 * views. Each is read from the chain when added and again when the gateway starts, so an agent
 * whose wallet moved (or whose token was transferred, which clears it) is no longer named.
 */
export class AgentDirectory {
  private readonly byWallet = new Map<string, AgentIdentity>();

  constructor(
    private readonly chain: IdentityChain,
    private readonly registry: Address,
    private readonly chainId: number,
  ) {}

  get registryId(): string {
    return agentRegistryId(this.chainId, this.registry);
  }

  /** Reads the agent's wallet on chain and remembers it; null if the agent does not exist. */
  async add(store: Pick<Store, 'upsertAgent'>, agentId: bigint): Promise<AgentIdentity | null> {
    let wallet: Address;
    try {
      wallet = getAddress(await this.chain.agentWallet(agentId));
    } catch {
      return null;
    }
    if (/^0x0{40}$/i.test(wallet)) return null; // registered, but no wallet set
    const row = await store.upsertAgent({
      agentId: agentId.toString(),
      registry: this.registryId,
      wallet,
    });
    for (const [k, v] of this.byWallet) if (v.agentId === row.agentId) this.byWallet.delete(k);
    const identity = { agentId: row.agentId, registry: row.registry, wallet };
    this.byWallet.set(wallet.toLowerCase(), identity);
    return identity;
  }

  /** Loads the stored agents, keeping only those whose wallet on chain is still the stored one. */
  async load(store: Pick<Store, 'listAgents'>): Promise<void> {
    this.byWallet.clear();
    for (const row of await store.listAgents()) {
      try {
        const wallet = await this.chain.agentWallet(BigInt(row.agentId));
        if (wallet.toLowerCase() !== row.wallet.toLowerCase()) continue;
        this.byWallet.set(row.wallet.toLowerCase(), {
          agentId: row.agentId,
          registry: row.registry,
          wallet: getAddress(row.wallet),
        });
      } catch (e) {
        console.error(`agent ${row.agentId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  byAddress(address: string | null): AgentIdentity | undefined {
    return address === null ? undefined : this.byWallet.get(address.toLowerCase());
  }

  list(): AgentIdentity[] {
    return [...this.byWallet.values()].sort((a, b) =>
      Number(BigInt(a.agentId) - BigInt(b.agentId)),
    );
  }

  /** The `agent` field of a payment view. */
  viewOf(address: string | null) {
    if (address === null) return null;
    const known = this.byAddress(address);
    return {
      address: getAddress(address),
      agentId: known?.agentId ?? null,
      registry: known?.registry ?? null,
    };
  }
}
