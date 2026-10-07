import type { z } from 'zod';
import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AgentCard,
  Role,
  TaskState,
  type Message,
  type Part,
  type Task,
} from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  defaultServerCallContextBuilder,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  validateVersion,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type User,
} from '@a2a-js/sdk/server';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';
import { Countersign } from '@countersign/sdk';
import { accessVerifier, type AuthKit } from './auth';
import { createTools } from './tools';

/**
 * The A2A door (Slice 19 part B): agents that speak Agent2Agent (Google ADK, Azure AI Foundry,
 * Bedrock AgentCore, Agentforce) pay through Countersign as they reach any other agent. The same
 * six skills as the MCP tools, the same code behind them, the same sign-in (a WorkOS token or the
 * bearer token). A payment held for the owner is an `auth-required` task: the owner's passkey is
 * the authorisation it waits for, and the task's message carries the approval link.
 */

export type A2AOptions = {
  gatewayUrl: string;
  gatewayToken: string;
  chainId: number;
  account: `0x${string}`;
  agentKey: `0x${string}`;
  mcpToken: string;
  authkit?: AuthKit;
  /** Where the MCP server is reached, e.g. https://countersign-mcp.vercel.app. */
  publicUrl: string;
  fetch?: typeof fetch;
  waitMs?: number;
};

type Tools = ReturnType<typeof createTools>;
type SkillId = keyof Tools;
type ToolResult = Awaited<ReturnType<Tools['list_open_orders']['handler']>>;

const SKILL_EXAMPLES: Record<SkillId, string> = {
  list_open_orders: '{"skill":"list_open_orders"}',
  check_invoice:
    '{"skill":"check_invoice","orderId":"0x…","invoiceNumber":"INV-0042","amount":"12.50","payTo":"0x…"}',
  pay_invoice:
    '{"skill":"pay_invoice","orderId":"0x…","invoiceNumber":"INV-0042","amount":"12.50","payTo":"0x…"}',
  pay_invoices:
    '{"skill":"pay_invoices","invoices":[{"orderId":"0x…","invoiceNumber":"INV-0042","amount":"12.50","payTo":"0x…"}]}',
  payment_status: '{"skill":"payment_status","id":"0x…"}',
  propose_order:
    '{"skill":"propose_order","supplierName":"Kalibre Studio","website":"https://kalibre.example","payTo":"0x…","amount":"250","validForDays":30,"quoteText":"…"}',
};

const textPart = (value: string): Part => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});
const dataPart = (value: Record<string, unknown>): Part => ({
  content: { $case: 'data', value },
  metadata: undefined,
  filename: '',
  mediaType: 'application/json',
});
const agentMessage = (contextId: string, taskId: string, text: string): Message => ({
  messageId: crypto.randomUUID(),
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: [textPart(text)],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

/** What the caller asked for: a data part (or a text part holding JSON) naming a skill. */
function requestOf(message: Message): { skill: string; args: Record<string, unknown> } | undefined {
  for (const part of message.parts) {
    let value: unknown;
    if (part.content?.$case === 'data') value = part.content.value;
    else if (part.content?.$case === 'text') {
      try {
        value = JSON.parse(part.content.value);
      } catch {
        continue;
      }
    }
    if (typeof value === 'object' && value !== null && 'skill' in value) {
      const { skill, ...args } = value as { skill: unknown } & Record<string, unknown>;
      if (typeof skill === 'string') return { skill, args };
    }
  }
  return undefined;
}

/** A payment's outcome as a task state: held waits for the owner's passkey. */
function stateOf(skill: SkillId, result: ToolResult): TaskState {
  if (result.isError === true) return TaskState.TASK_STATE_FAILED;
  if (skill !== 'pay_invoice') return TaskState.TASK_STATE_COMPLETED;
  switch (result.structuredContent?.status) {
    case 'held':
      return TaskState.TASK_STATE_AUTH_REQUIRED;
    case 'refused':
    case 'blocked':
    case 'expired':
      return TaskState.TASK_STATE_REJECTED;
    case 'failed':
      return TaskState.TASK_STATE_FAILED;
    default:
      // Settled, or accepted and not final yet (the message says to check payment_status).
      return TaskState.TASK_STATE_COMPLETED;
  }
}

class CountersignExecutor implements AgentExecutor {
  constructor(private readonly tools: Tools) {}

  cancelTask = (): Promise<void> => Promise.resolve(); // every skill finishes in seconds

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId } = context;
    const request = requestOf(userMessage);
    if (!request || !(request.skill in this.tools)) {
      bus.publish(
        AgentEvent.message(
          agentMessage(
            contextId,
            '',
            `Send a data part (or JSON text) naming a skill. Skills: ${Object.values(SKILL_EXAMPLES).join(' | ')}`,
          ),
        ),
      );
      bus.finished();
      return;
    }
    const skill = request.skill as SkillId;
    const now = () => new Date().toISOString();
    const task: Task = {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_WORKING, timestamp: now(), message: undefined },
      artifacts: [],
      history: [userMessage],
      metadata: undefined,
    };
    bus.publish(AgentEvent.task(task));

    const tool = this.tools[skill] as {
      config: { inputSchema: z.ZodType };
      handler: (args: unknown) => Promise<ToolResult>;
    };
    const parsed = tool.config.inputSchema.safeParse(request.args);
    if (!parsed.success) {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_REJECTED,
            timestamp: now(),
            message: agentMessage(
              contextId,
              taskId,
              `Not a valid ${skill} request: ${parsed.error.message}. Example: ${SKILL_EXAMPLES[skill]}`,
            ),
          },
          metadata: undefined,
        }),
      );
      bus.finished();
      return;
    }
    const result = await tool.handler(parsed.data);
    const text = result.content.map((c) => c.text).join('\n');
    if (result.structuredContent)
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: crypto.randomUUID(),
            name: skill,
            description: text.split('\n')[0] ?? skill,
            parts: [dataPart(result.structuredContent), textPart(text)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: stateOf(skill, result),
          timestamp: now(),
          message: agentMessage(contextId, taskId, text),
        },
        metadata: undefined,
      }),
    );
    bus.finished();
  }
}

class SignedInUser implements User {
  constructor(private readonly name: string) {}
  get isAuthenticated() {
    return true;
  }
  get userName() {
    return this.name;
  }
}

const CORS = { 'access-control-allow-origin': '*' };

export function createA2A(options: A2AOptions) {
  const base = options.publicUrl.replace(/\/$/, '');
  const cs = new Countersign({
    gateway: options.gatewayUrl,
    token: options.gatewayToken,
    account: options.account,
    agentKey: options.agentKey,
    chainId: options.chainId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const tools = createTools(cs, options.waitMs === undefined ? {} : { waitMs: options.waitMs });

  const card: AgentCard = {
    name: 'Countersign',
    description:
      'Pays supplier invoices in USDC on Monad, but only what the business approved: the supplier, the address on file, the order. A match settles in about a second; anything else is held for the owner, who decides with a passkey. The account contract enforces it.',
    supportedInterfaces: duplicateInterfacesForLegacy(
      [
        {
          url: `${base}/api/a2a`,
          protocolBinding: 'JSONRPC',
          tenant: '',
          protocolVersion: A2A_PROTOCOL_VERSION,
        },
      ],
      ['JSONRPC'],
    ),
    provider: { organization: 'Countersign', url: 'https://github.com/AfshalG/countersign' },
    version: '0.1.0',
    documentationUrl: 'https://gateway-production-e17a.up.railway.app/docs',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description:
              'A WorkOS access token (sign in through this server’s /.well-known/oauth-protected-resource) or a Countersign token',
            scheme: 'Bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
    securityRequirements: [],
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: (Object.keys(SKILL_EXAMPLES) as SkillId[]).map((id) => ({
      id,
      name: tools[id].config.title,
      description: tools[id].config.description,
      tags: ['payments', 'invoices', 'monad', 'usdc'],
      examples: [SKILL_EXAMPLES[id]],
      inputModes: ['application/json'],
      outputModes: ['application/json', 'text/plain'],
      securityRequirements: [],
    })),
    signatures: [],
  };
  const handler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new CountersignExecutor(tools),
  );
  const v1 = new JsonRpcTransportHandler(handler);
  const legacy = new LegacyJsonRpcTransportHandler(handler);
  const verify = accessVerifier(options.mcpToken, options.authkit);
  const resourceMetadata = `${options.authkit ? new URL(options.authkit.audience).origin : base}/.well-known/oauth-protected-resource`;

  return {
    /** GET /.well-known/agent-card.json: the v1.0 card, with v0.3's top-level fields for older clients. */
    card(): Response {
      return Response.json(
        {
          ...(AgentCard.toJSON(card) as Record<string, unknown>),
          protocolVersion: '0.3.0',
          url: `${base}/api/a2a`,
          preferredTransport: 'JSONRPC',
        },
        { headers: { ...CORS, 'cache-control': 'max-age=300' } },
      );
    },

    /** POST /api/a2a: JSON-RPC, v1.0 when the caller says so, v0.3 otherwise. */
    async rpc(req: Request): Promise<Response> {
      const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
      const auth = await verify(req, bearer);
      if (!auth)
        return Response.json(
          { error: 'unauthorized' },
          {
            status: 401,
            headers: {
              ...CORS,
              'www-authenticate': `Bearer error="invalid_token", resource_metadata="${resourceMetadata}"`,
            },
          },
        );
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
          { headers: CORS },
        );
      }
      const requestedVersion = req.headers.get(A2A_VERSION_HEADER) ?? undefined;
      const extra = auth.extra as { userId?: string } | undefined;
      const context = defaultServerCallContextBuilder({
        extensions: undefined,
        user: new SignedInUser(extra?.userId ?? auth.clientId),
        headers: Object.fromEntries(req.headers),
        ...(requestedVersion === undefined ? {} : { requestedVersion }),
      });
      const id = (body as { id?: unknown }).id ?? null;
      try {
        validateVersion(context.requestedVersion, card, 'JSONRPC');
        const isLegacy = context.requestedVersion.startsWith('0.');
        const result = await (isLegacy ? legacy : v1).handle(
          body as Record<string, unknown>,
          context,
        );
        if (typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
          // Streaming is not offered (capabilities.streaming is false); answer as the spec says.
          return Response.json(
            { jsonrpc: '2.0', id, error: { code: -32004, message: 'Streaming is not supported' } },
            { headers: CORS },
          );
        }
        return Response.json(result, { headers: CORS });
      } catch (e) {
        return Response.json(
          { jsonrpc: '2.0', id, error: JsonRpcTransportHandler.mapToJSONRPCError(e) },
          { headers: CORS },
        );
      }
    },
  };
}
