import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  stringToHex,
  concat,
  type Address,
} from 'viem';
import {
  AGENT_WALLET_SET_TYPES,
  IDENTITY_REGISTRY_TESTNET,
  identityDomain,
  registrationFile,
} from '../src/erc8004.js';

const AGENT = '0x2222222222222222222222222222222222222222' as Address;
const OWNER = '0xf8a69BdB48aeae88136C7F9D87FeB2B24458C79B' as Address;

describe('ERC-8004 identity (Monad testnet registry, version 2.0.0)', () => {
  it('builds the digest setAgentWallet checks, exactly as the registry builds it', () => {
    // Independently: keccak256(0x1901 ‖ domainSeparator ‖ structHash), from the registry's source.
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [
          keccak256(
            stringToHex(
              'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
            ),
          ),
          keccak256(stringToHex('ERC8004IdentityRegistry')),
          keccak256(stringToHex('1')),
          10143n,
          IDENTITY_REGISTRY_TESTNET,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint256' },
        ],
        [
          keccak256(
            stringToHex(
              'AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)',
            ),
          ),
          42n,
          AGENT,
          OWNER,
          1_791_000_000n,
        ],
      ),
    );
    expect(
      hashTypedData({
        domain: identityDomain(10143, IDENTITY_REGISTRY_TESTNET),
        types: AGENT_WALLET_SET_TYPES,
        primaryType: 'AgentWalletSet',
        message: { agentId: 42n, newWallet: AGENT, owner: OWNER, deadline: 1_791_000_000n },
      }),
    ).toBe(keccak256(concat(['0x1901', domainSeparator, structHash])));
  });

  it('writes a registration file in the ERC-8004 format, naming our MCP and A2A doors', () => {
    const file = registrationFile({
      name: 'Countersign hosted agent',
      description: 'Pays supplier invoices through Countersign.',
      mcp: 'https://countersign-mcp.vercel.app/api/mcp',
      a2a: 'https://countersign-mcp.vercel.app/.well-known/agent-card.json',
      agentId: 7n,
      chainId: 10143,
      registry: IDENTITY_REGISTRY_TESTNET,
    });
    expect(file).toMatchObject({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Countersign hosted agent',
      services: [
        { name: 'MCP', endpoint: 'https://countersign-mcp.vercel.app/api/mcp' },
        { name: 'A2A', endpoint: 'https://countersign-mcp.vercel.app/.well-known/agent-card.json' },
      ],
      registrations: [{ agentId: 7, agentRegistry: `eip155:10143:${IDENTITY_REGISTRY_TESTNET}` }],
      supportedTrust: ['reputation'],
    });
    // Before it has an id, it lists no registration.
    expect(
      registrationFile({
        name: 'x',
        description: 'y',
        mcp: 'https://m',
        chainId: 10143,
        registry: IDENTITY_REGISTRY_TESTNET,
      }).registrations,
    ).toEqual([]);
  });
});
