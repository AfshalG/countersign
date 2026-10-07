import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRequestListener } from '@hono/node-server';
import { createMCPClient } from '@ai-sdk/mcp';
import { getAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { createServer } from '../lib/server';
import {
  ACCOUNT,
  gateway,
  LOOK_ALIKE,
  MCP_TOKEN,
  ON_FILE,
  ORDER_ID,
  sent,
  TX,
} from './fake-gateway';

let http: Server;
let url: string;
let client: Awaited<ReturnType<typeof createMCPClient>>;

beforeAll(async () => {
  const handler = createServer({
    gatewayUrl: 'https://gateway.test',
    gatewayToken: 'gateway-token-0123456789abcdef',
    chainId: 10143,
    account: ACCOUNT,
    agentKey: generatePrivateKey(),
    mcpToken: MCP_TOKEN,
    fetch: gateway,
    waitMs: 500,
  });
  const listener = getRequestListener(handler);
  http = createHttpServer((req, res) => {
    void listener(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/api/mcp`;
  client = await createMCPClient({
    transport: { type: 'http', url, headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
});
afterAll(async () => {
  await client.close();
  await new Promise((resolve) => http.close(resolve));
});

type CallResult = {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallResult;
const textOf = (r: CallResult) => r.content.map((c) => c.text ?? '').join('\n');

describe('the MCP server', () => {
  it('refuses a client without the token', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('offers the six tools, read-only where nothing moves and idempotent where money does', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        'check_invoice',
        'list_open_orders',
        'pay_invoice',
        'pay_invoices',
        'payment_status',
        'propose_order',
      ].sort(),
    );
    for (const name of ['list_open_orders', 'check_invoice', 'payment_status'])
      expect(byName[name]?.annotations, name).toMatchObject({ readOnlyHint: true });
    for (const name of ['pay_invoice', 'pay_invoices'])
      expect(byName[name]?.annotations, name).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
      });
    expect(byName.propose_order?.annotations).toMatchObject({ destructiveHint: false });
  });

  it('lists the open order and the only address it pays', async () => {
    const r = await call('list_open_orders', {});
    expect(textOf(r)).toContain(`17.50 of 30.00 USDC left, pays only ${ON_FILE}`);
    expect(r.structuredContent).toMatchObject({
      orders: [{ orderId: ORDER_ID, addressOnFile: ON_FILE }],
    });
  });

  it('pays a clean invoice and says so, with the transaction', async () => {
    const r = await call('pay_invoice', {
      orderId: ORDER_ID,
      invoiceNumber: 'INV-0042',
      amount: '12.50',
      payTo: ON_FILE,
    });
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).toContain('Paid 12.50 USDC');
    expect(textOf(r)).toContain(TX);
    const payment = sent.find((s) => s.path === '/v1/payments')?.body as {
      payment: { amount: string };
      agentSig: string;
    };
    expect(payment.payment.amount).toBe('12500000');
    expect(payment.agentSig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('says plainly when an invoice was sent before: nothing new paid', async () => {
    const args = { orderId: ORDER_ID, invoiceNumber: 'INV-0099', amount: '12.50', payTo: ON_FILE };
    const first = await call('pay_invoice', args);
    const again = await call('pay_invoice', args);
    expect(first.structuredContent).toMatchObject({ duplicate: false });
    expect(again.structuredContent).toMatchObject({ duplicate: true });
    expect(textOf(again)).toMatch(
      /^This is the same invoice as an earlier request .*nothing new was paid/,
    );
  });

  it('holds a look-alike and tells the agent not to retry around it', async () => {
    const r = await call('pay_invoice', {
      orderId: ORDER_ID,
      invoiceNumber: 'INV-0045',
      amount: 12.5,
      payTo: LOOK_ALIKE,
    });
    const said = textOf(r);
    expect(said).toContain('Held; nothing was paid.');
    expect(said).toContain(`Address on file: ${ON_FILE}`);
    expect(said).toContain(`Address on the invoice: ${getAddress(LOOK_ALIKE)}`);
    expect(said).toMatch(/The owner decides here: https:\/\/gateway\.test\/p\//);
    expect(said).toContain('Do not retry');
    expect(r.structuredContent).toMatchObject({
      status: 'held',
      reason: 'address_mismatch',
      addressOnFile: ON_FILE,
    });
  });

  it('checks without paying', async () => {
    const r = await call('check_invoice', {
      orderId: ORDER_ID,
      invoiceNumber: 'INV-0050',
      amount: '1',
      payTo: ON_FILE,
    });
    expect(textOf(r)).toContain('Nothing was paid.');
    expect(r.structuredContent).toMatchObject({ verdict: 'would_settle' });
  });

  it('looks up a payment, then a run, then a proposal, by id', async () => {
    expect(textOf(await call('payment_status', { id: '0xrun' }))).toContain(
      'Run of 2: 1 settled, 1 held.',
    );
    expect(textOf(await call('payment_status', { id: '0xprop' }))).toContain(
      'Proposal for Kalibre Studio: pending',
    );
  });

  it('proposes an order: a link, nothing changed', async () => {
    const r = await call('propose_order', {
      supplierName: 'Kalibre Studio',
      website: 'https://kalibre.example',
      payTo: ON_FILE,
      amount: '4200.00',
      quoteText: 'Quote Q-2026-001',
    });
    expect(textOf(r)).toContain('Nothing changes until the owner approves it with their passkey');
  });

  it('reports a refused input plainly instead of failing', async () => {
    const r = await call('pay_invoice', {
      orderId: ORDER_ID,
      invoiceNumber: 'INV-1',
      amount: '1.2345678',
      payTo: ON_FILE,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/USDC amount/);
  });
});
