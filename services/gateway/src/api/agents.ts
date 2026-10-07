import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Store } from '../db/store.js';
import type { AgentDirectory } from '../agents/identity.js';

/**
 * ERC-8004 agents the gateway names on payments (Slice 19). Adding one reads its wallet from the
 * Identity Registry; payments whose agent signature recovers to that wallet then show its id.
 * Service token, like the rest of /v1.
 */

const agentView = z
  .object({
    agentId: z.string(),
    registry: z
      .string()
      .openapi({ example: 'eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e' }),
    wallet: z
      .string()
      .openapi({ description: 'The key that signs this agent’s payments (getAgentWallet)' }),
  })
  .openapi('Agent');
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const addAgent = createRoute({
  method: 'post',
  path: '/v1/agents',
  tags: ['Agents'],
  summary: 'Name an ERC-8004 agent on the payments its key signs',
  description:
    'Register the agent in the Identity Registry and set its agentWallet to the key that signs its payments first; this reads that wallet from the chain.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            agentId: z
              .string()
              .regex(/^\d{1,20}$/)
              .openapi({ example: '2066' }),
          }),
        },
      },
    },
  },
  responses: {
    200: json(agentView, 'The agent, as the registry has it'),
    404: json(z.object({ error: z.string() }), 'unknown_agent: no such agent, or no wallet set'),
  },
});

const listAgents = createRoute({
  method: 'get',
  path: '/v1/agents',
  tags: ['Agents'],
  summary: 'The ERC-8004 agents this gateway names',
  responses: {
    200: json(z.object({ registry: z.string(), agents: z.array(agentView) }), 'The agents'),
  },
});

export function registerAgentRoutes(
  app: OpenAPIHono,
  deps: { store: Pick<Store, 'upsertAgent'>; agents: AgentDirectory },
): void {
  app.openapi(addAgent, async (c) => {
    const added = await deps.agents.add(deps.store, BigInt(c.req.valid('json').agentId));
    return added ? c.json(added, 200) : c.json({ error: 'unknown_agent' }, 404);
  });
  app.openapi(listAgents, (c) =>
    c.json({ registry: deps.agents.registryId, agents: deps.agents.list() }, 200),
  );
}
