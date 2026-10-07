/**
 * Registers one of Countersign's agents in Monad testnet's ERC-8004 Identity Registry (Slice 19):
 * the deployer registers it (and owns it), then sets its `agentWallet` to the key that signs its
 * payments, with that key's EIP-712 consent. After this, anyone can tie a payment to the agent:
 * the payment's agent signature recovers to `getAgentWallet(agentId)`. Run once per agent; if the
 * agent id is given, only the wallet is (re)set and checked.
 *
 *   pnpm --filter @countersign/gateway register-agent hosted [agentId]
 *   pnpm --filter @countersign/gateway register-agent demo [agentId]
 */
import { z } from 'zod';
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, identityRegistryAbi } from '@countersign/chain';
import {
  AGENT_WALLET_SET_TYPES,
  IDENTITY_REGISTRY_TESTNET,
  identityDomain,
  loadEnv,
} from '@countersign/shared';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    SLICE5_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    DEMO_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
);
const AGENTS = {
  // The hosted agent behind the MCP tools: it signs the demo account's payments.
  hosted: {
    key: env.SLICE5_AGENT_PRIVATE_KEY,
    uri: 'https://countersign-mcp.vercel.app/agents/countersign-hosted.json',
  },
  // Judge mode's demo agent: it signs the payments into judges' accounts.
  demo: {
    key: env.DEMO_AGENT_PRIVATE_KEY,
    uri: 'https://countersign-mcp.vercel.app/agents/countersign-demo.json',
  },
} as const;
const which = process.argv[2];
if (which !== 'hosted' && which !== 'demo')
  throw new Error('usage: register-agent hosted|demo [agentId]');
const agentKey = privateKeyToAccount(AGENTS[which].key as Hex);
const owner = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const registry = IDENTITY_REGISTRY_TESTNET;
const transport = http(chain.rpcUrls.default.http[0]);
const reader = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account: owner, chain, transport });

let agentId = process.argv[3] === undefined ? undefined : BigInt(process.argv[3]);
if (agentId === undefined) {
  const { request } = await reader.simulateContract({
    account: owner,
    address: registry,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [AGENTS[which].uri],
  });
  const hash = await wallet.writeContract(request);
  const receipt = await reader.waitForTransactionReceipt({ hash });
  const [registered] = parseEventLogs({
    abi: identityRegistryAbi,
    logs: receipt.logs,
    eventName: 'Registered',
  });
  if (!registered) throw new Error(`no Registered event in ${hash}`);
  agentId = registered.args.agentId;
  console.log(
    `registered agent ${String(agentId)} (${which}) owned by ${owner.address}, tx ${hash}`,
  );
}

// The agent key consents to being this agent's wallet (the registry allows a deadline 5 minutes out).
const block = await reader.getBlock();
const deadline = block.timestamp + 240n;
const signature = await agentKey.signTypedData({
  domain: identityDomain(chain.id, registry),
  types: AGENT_WALLET_SET_TYPES,
  primaryType: 'AgentWalletSet',
  message: { agentId, newWallet: agentKey.address, owner: owner.address, deadline },
});
const { request } = await reader.simulateContract({
  account: owner,
  address: registry,
  abi: identityRegistryAbi,
  functionName: 'setAgentWallet',
  args: [agentId, agentKey.address, deadline, signature],
});
const hash = await wallet.writeContract(request);
await reader.waitForTransactionReceipt({ hash });
const onChain = await reader.readContract({
  address: registry,
  abi: identityRegistryAbi,
  functionName: 'getAgentWallet',
  args: [agentId],
});
if (onChain.toLowerCase() !== agentKey.address.toLowerCase())
  throw new Error(`agentWallet is ${onChain}, expected ${agentKey.address}`);
console.log(
  `agent ${String(agentId)} wallet set to ${onChain} (the key that signs its payments), tx ${hash}`,
);
