import type { Address } from 'viem';

/**
 * ERC-8004 (Trustless Agents) on Monad testnet: the Identity Registry, version 2.0.0, read on
 * chain and in `erc-8004/erc-8004-contracts` (IdentityRegistryUpgradeable.sol) on 7 Oct 2026.
 * An agent is an ERC-721 token; its `agentWallet` is the key it signs with. Countersign sets an
 * agent's wallet to the key that signs its payments, so anyone can tie a payment to its agent.
 */
export const IDENTITY_REGISTRY_TESTNET: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
/** The testnet Reputation Registry (`giveFeedback`); there is no Validation Registry on testnet. */
export const REPUTATION_REGISTRY_TESTNET: Address = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

/** The registry's EIP-712 domain (its `eip712Domain()`: "ERC8004IdentityRegistry", "1"). */
export const identityDomain = (chainId: number, registry: Address) =>
  ({
    name: 'ERC8004IdentityRegistry',
    version: '1',
    chainId,
    verifyingContract: registry,
  }) as const;

/** What the new wallet signs to accept being an agent's wallet (deadline at most 5 minutes out). */
export const AGENT_WALLET_SET_TYPES = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** The agent's registry in the form registration files use: `eip155:{chainId}:{registry}`. */
export const agentRegistryId = (chainId: number, registry: Address) =>
  `eip155:${String(chainId)}:${registry}`;

/** An agent's registration file (the ERC-8004 `agentURI` points at it). */
export function registrationFile(input: {
  name: string;
  description: string;
  mcp: string;
  a2a?: string;
  agentId?: bigint;
  chainId: number;
  registry: Address;
}) {
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: input.name,
    description: input.description,
    services: [
      { name: 'MCP', endpoint: input.mcp, version: '2025-06-18' },
      ...(input.a2a === undefined ? [] : [{ name: 'A2A', endpoint: input.a2a, version: '1.0' }]),
    ],
    registrations:
      input.agentId === undefined
        ? []
        : [
            {
              agentId: Number(input.agentId),
              agentRegistry: agentRegistryId(input.chainId, input.registry),
            },
          ],
    supportedTrust: ['reputation'],
  };
}
