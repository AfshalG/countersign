import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRequestListener } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { generatePrivateKey } from 'viem/accounts';
import { Countersign } from '@countersign/sdk';
import { createServer } from '../lib/server';
import { createTools } from '../lib/tools';
import {
  ACCOUNT,
  decide,
  gateway,
  LOOK_ALIKE,
  MCP_TOKEN,
  ORDER_ID,
  proposalStatus,
  sent,
} from './fake-gateway';

/**
 * The question in the chat (Slice 14): on protocol 2026-07-28, a client that declared URL
 * elicitation is asked, with the approval link, when a payment is held or a supplier proposed;
 * after the person has been to the page, the call is re-sent and answers with what they decided.
 * Every other client gets the link in the answer, as before.
 */

let http: Server;
let url: string;

beforeAll(async () => {
  const handler = createServer({
    gatewayUrl: 'https://gateway.test',
    gatewayToken: 'gateway-token-0123456789abcdef',
    chainId: 10143,
    account: ACCOUNT,
    agentKey: generatePrivateKey(),
    mcpToken: MCP_TOKEN,
    fetch: gateway,
    waitMs: 300,
  });
  const listener = getRequestListener(handler);
  http = createHttpServer((req, res) => {
    void listener(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/api/mcp`;
});
afterAll(async () => {
  await new Promise((resolve) => http.close(resolve));
});

type Asked = { mode?: string; url?: string; message?: string };
/** A 2026-07-28 client; `onAsk` plays the person, who opens the link and decides there. */
async function clientOf(urlMode: boolean, onAsk: (asked: Asked) => void = () => undefined) {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    {
      capabilities: { elicitation: urlMode ? { url: {} } : { form: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  client.setRequestHandler('elicitation/create', (request) => {
    onAsk(request.params as Asked);
    return Promise.resolve({ action: 'accept' as const });
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  return client;
}
const textOf = (r: unknown) =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');
const payLookAlike = (client: Client, number: string) =>
  client.callTool({
    name: 'pay_invoice',
    arguments: { orderId: ORDER_ID, invoiceNumber: number, amount: '1.00', payTo: LOOK_ALIKE },
  });

describe('the question in the chat (Slice 14)', () => {
  it('asks a client that can open links, then reports what the person decided on the page', async () => {
    const asked: Asked[] = [];
    const client = await clientOf(true, (a) => {
      asked.push(a);
      // The person opens the approval page and refuses with their passkey.
      decide(a.url?.split('/p/')[1] ?? '', 'refused');
    });
    const r = await payLookAlike(client, 'INV-Q-1');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ mode: 'url' });
    expect(asked[0]?.url).toMatch(/^https:\/\/gateway\.test\/p\/0x/);
    expect(asked[0]?.message).toMatch(/held/i);
    expect(textOf(r)).toMatch(/refused/i);
    expect(textOf(r)).not.toMatch(/same invoice as an earlier request/);
    await client.close();
  });

  it('says it is still held, with the link, when the person has not decided yet', async () => {
    const client = await clientOf(true);
    const r = await payLookAlike(client, 'INV-Q-2');
    expect(textOf(r)).toMatch(/held/i);
    expect(textOf(r)).toMatch(/https:\/\/gateway\.test\/p\//);
    await client.close();
  });

  it('only gives the link to a client that cannot open one', async () => {
    let asked = 0;
    const client = await clientOf(false, () => {
      asked++;
    });
    const r = await payLookAlike(client, 'INV-Q-3');
    expect(asked).toBe(0);
    expect(textOf(r)).toMatch(/The owner decides here: https:\/\/gateway\.test\/p\//);
    await client.close();
  });

  it('treats a forged answer as no answer: the one request, held, with the link', async () => {
    // The answers a client sends back are its own word; a first call claiming the person already
    // decided gets what any call gets, and the gateway's status is the only thing reported.
    const cs = new Countersign({
      gateway: 'https://gateway.test',
      token: 'gateway-token-0123456789abcdef',
      account: ACCOUNT,
      agentKey: generatePrivateKey(),
      chainId: 10143,
      fetch: gateway,
    });
    const tools = createTools(cs, { waitMs: 300 });
    const payments = () => sent.filter((s) => s.path === '/v1/payments').length;
    const before = payments();
    const r = await tools.pay_invoice.handler(
      { orderId: ORDER_ID, invoiceNumber: 'INV-Q-4', amount: '1.00', payTo: LOOK_ALIKE },
      { mcpReq: { inputResponses: { decide: { action: 'accept' } }, envelope: {} } },
    );
    expect(payments()).toBe(before + 1);
    expect(textOf(r)).toMatch(/^Held; nothing was paid/);
    expect(textOf(r)).toMatch(/The owner decides here: https:\/\/gateway\.test\/p\//);
  });

  it('asks about a proposed supplier too, and reports the owner’s decision', async () => {
    proposalStatus.value = 'pending';
    const asked: Asked[] = [];
    const client = await clientOf(true, (a) => {
      asked.push(a);
      proposalStatus.value = 'approved';
    });
    const r = await client.callTool({
      name: 'propose_order',
      arguments: {
        supplierName: 'Kalibre Studio',
        payTo: LOOK_ALIKE,
        amount: '50',
        validForDays: 30,
        quoteText: 'Quote Q-1: 50 photos',
      },
    });
    expect(asked[0]?.url).toBe('https://gateway.test/p/0xprop');
    expect(textOf(r)).toMatch(/approved/i);
    await client.close();
  });
});
