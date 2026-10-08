import { beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';
import { createA2A } from '../lib/a2a';
import { ACCOUNT, gateway, LOOK_ALIKE, MCP_TOKEN, ON_FILE, ORDER_ID, TX } from './fake-gateway';

/**
 * The A2A door (Slice 19 part B), driven by the A2A project's own JavaScript client: what an
 * agent built on Google ADK, Azure AI Foundry, Bedrock AgentCore or Agentforce does.
 */
const BASE = 'https://mcp.test';
const a2a = createA2A({
  gatewayUrl: 'https://gateway.test',
  gatewayToken: 'gateway-token-0123456789abcdef',
  chainId: 10143,
  account: ACCOUNT,
  agentKey: generatePrivateKey(),
  mcpToken: MCP_TOKEN,
  publicUrl: BASE,
  fetch: gateway,
  waitMs: 500,
});

/** The network, as the client sees it: the card and the JSON-RPC endpoint, with or without a token. */
const network =
  (token: string | undefined): typeof fetch =>
  (input, init) => {
    const req = new Request(input instanceof Request ? input : String(input), init);
    const path = new URL(req.url).pathname;
    if (path === '/.well-known/agent-card.json') return Promise.resolve(a2a.card());
    if (path === '/api/a2a') {
      const headers = new Headers(req.headers);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return a2a.rpc(new Request(req, { headers }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };

let client: Client;
beforeAll(async () => {
  const fetchImpl = network(MCP_TOKEN);
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  });
  client = await factory.createFromUrl(BASE);
});

const send = async (data: Record<string, unknown> | string) => {
  const message: Message = {
    messageId: crypto.randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      typeof data === 'string'
        ? {
            content: { $case: 'text', value: data },
            metadata: undefined,
            filename: '',
            mediaType: 'text/plain',
          }
        : {
            content: { $case: 'data', value: data },
            metadata: undefined,
            filename: '',
            mediaType: 'application/json',
          },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
  return client.sendMessage({ tenant: '', message, configuration: undefined, metadata: undefined });
};
const asTask = (r: Message | Task): Task => {
  if (!('status' in r)) throw new Error('expected a task');
  return r;
};
const textOf = (t: Task) =>
  (t.status?.message?.parts ?? [])
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join('\n');
const dataOf = (t: Task) =>
  t.artifacts
    .flatMap((a) => a.parts)
    .map((p) =>
      p.content?.$case === 'data' ? (p.content.value as Record<string, unknown>) : undefined,
    )
    .find((d) => d !== undefined);

describe('the A2A door', () => {
  it('publishes an Agent Card any A2A client can read (v1.0, and v0.3 for older clients)', async () => {
    const res = a2a.card();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const card = (await res.json()) as Record<string, unknown> & {
      supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string }[];
      skills: { id: string }[];
    };
    expect(card.name).toBe('Countersign');
    expect(
      card.supportedInterfaces.map((i) => `${i.protocolBinding} ${i.protocolVersion}`).sort(),
    ).toEqual(['JSONRPC 0.3', 'JSONRPC 1.0']);
    expect(card.skills.map((s) => s.id).sort()).toEqual([
      'check_invoice',
      'list_open_orders',
      'pay_invoice',
      'pay_invoices',
      'payment_status',
      'propose_order',
    ]);
    expect(card).toMatchObject({
      url: `${BASE}/api/a2a`,
      preferredTransport: 'JSONRPC',
      protocolVersion: '0.3.0',
    });
  });

  it('refuses a call without a token, pointing to where to sign in', async () => {
    const res = await network(undefined)(`${BASE}/api/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('lists the open orders as a completed task with the orders as data', async () => {
    const task = asTask(await send({ skill: 'list_open_orders' }));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(dataOf(task)).toMatchObject({ orders: [{ orderId: ORDER_ID, addressOnFile: ON_FILE }] });
  });

  it('pays an invoice to the address on file: completed, with the transaction', async () => {
    const task = asTask(
      await send({
        skill: 'pay_invoice',
        orderId: ORDER_ID,
        invoiceNumber: 'INV-A2A-1',
        amount: '12.50',
        payTo: ON_FILE,
      }),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(dataOf(task)).toMatchObject({ status: 'settled', txHash: TX });
  });

  it('holds a look-alike address: auth-required, with the owner’s approval link', async () => {
    const task = asTask(
      await send({
        skill: 'pay_invoice',
        orderId: ORDER_ID,
        invoiceNumber: 'INV-A2A-2',
        amount: '12.50',
        payTo: LOOK_ALIKE,
      }),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_AUTH_REQUIRED);
    expect(textOf(task)).toContain('Held; nothing was paid');
    expect(textOf(task)).toContain('https://gateway.test/p/');
  });

  it('answers a plain-text message with what it can do, rather than guessing', async () => {
    const reply = await send('pay my invoices please');
    expect('role' in reply).toBe(true);
    const text = (reply as Message).parts
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    expect(text).toContain('pay_invoice');
  });

  it('refuses arguments that do not fit the skill, as a rejected task', async () => {
    const task = asTask(await send({ skill: 'pay_invoice', orderId: ORDER_ID }));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
  });
});
