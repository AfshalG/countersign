import { IDENTITY_REGISTRY_TESTNET, registrationFile } from '@countersign/shared';

/**
 * Countersign's own agents in Monad testnet's ERC-8004 Identity Registry (Slice 19), registered
 * 7 Oct 2026 by `pnpm --filter @countersign/gateway register-agent`. Each agent's URI points at
 * its registration file here; its agentWallet is the key that signs its payments.
 */
const MCP = 'https://countersign-mcp.vercel.app';

export const AGENTS = {
  'countersign-hosted': {
    agentId: 2066n,
    name: 'Countersign hosted agent',
    description:
      'Pays supplier invoices for a business through Countersign: every payment is checked against the orders its owner approved with a passkey, and the account on Monad enforces it. Reached through the hosted MCP tools.',
  },
  'countersign-demo': {
    agentId: 2067n,
    name: 'Countersign demo agent',
    description:
      'Pays demo invoices into judge-mode accounts on Monad testnet, so a judge can watch a payment settle or be held and decide it with their own passkey.',
  },
} as const;

export function registrationOf(name: string) {
  const agent = AGENTS[name as keyof typeof AGENTS] as
    (typeof AGENTS)[keyof typeof AGENTS] | undefined;
  if (!agent) return undefined;
  return registrationFile({
    name: agent.name,
    description: agent.description,
    mcp: `${MCP}/api/mcp`,
    a2a: `${MCP}/.well-known/agent-card.json`,
    agentId: agent.agentId,
    chainId: 10143,
    registry: IDENTITY_REGISTRY_TESTNET,
  });
}
