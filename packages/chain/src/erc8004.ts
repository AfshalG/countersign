import { parseAbi } from 'viem';

/**
 * The parts of the ERC-8004 Identity Registry Countersign uses, from the reference source
 * (`erc-8004/erc-8004-contracts`, IdentityRegistryUpgradeable.sol, version 2.0.0), the version
 * deployed on Monad testnet at `IDENTITY_REGISTRY_TESTNET` (packages/shared).
 */
export const identityRegistryAbi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getVersion() pure returns (string)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);
