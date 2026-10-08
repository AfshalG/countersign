/**
 * The question in the chat, live (Slice 14): a 2026-07-28 client that can open links (the
 * official MCP client, as Claude Code is) pays a changed-address invoice through the hosted MCP
 * server. Countersign holds it and asks, with the approval link; the client plays a person who
 * comes back without deciding, and the re-sent call reports it still held. A client without URL
 * elicitation gets the link in the answer instead. Free: no model, and a held payment pays nothing.
 *
 *   pnpm --filter @countersign/mcp-server question-smoke [mcp URL]
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { pageText } from '@countersign/scripted-agent';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const token = process.env.MCP_SERVER_TOKEN ?? '';
if (token === '') throw new Error('set MCP_SERVER_TOKEN in the repo .env');
const mcp = process.argv[2] ?? 'https://countersign-mcp.vercel.app/api/mcp';
const site = 'https://countersign-supplier-demo.vercel.app';
const ACCOUNT = '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9';
const run = `Q${Date.now().toString(36).slice(-4).toUpperCase()}`;

type Asked = { mode?: string; url?: string; message?: string };
async function clientOf(urlMode: boolean, asked: Asked[]) {
  const client = new Client(
    { name: 'countersign-question-smoke', version: '1.0.0' },
    {
      capabilities: { elicitation: urlMode ? { url: {} } : { form: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  client.setRequestHandler('elicitation/create', (request) => {
    asked.push(request.params as Asked);
    return Promise.resolve({ action: 'accept' as const });
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
const textOf = (r: unknown) =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');

// The changed-address invoice, as an agent reads it; its own run label, so it is a new invoice.
const url = `${site}/invoices/ks-1002?account=${ACCOUNT}&run=${run}`;
const doc = (await (await fetch(`${url}&format=json`)).json()) as {
  number: string;
  payTo: string;
  totalUsdc: string;
};
const invoiceText = pageText(await (await fetch(url)).text());

let failed = false;
for (const urlMode of [true, false]) {
  const asked: Asked[] = [];
  const client = await clientOf(urlMode, asked);
  const { orders } = (await client.callTool({ name: 'list_open_orders', arguments: {} }))
    .structuredContent as { orders: { orderId: string }[] };
  const orderId = orders[0]?.orderId;
  if (!orderId) throw new Error('the main account has no open order');
  const started = Date.now();
  const r = await client.callTool({
    name: 'pay_invoice',
    arguments: {
      orderId,
      invoiceNumber: doc.number,
      amount: doc.totalUsdc,
      payTo: doc.payTo,
      invoiceText,
    },
  });
  const text = textOf(r);
  const ok = urlMode
    ? asked.length === 1 &&
      asked[0]?.mode === 'url' &&
      /\/p\/0x/.test(asked[0].url ?? '') &&
      /^Held/.test(text)
    : asked.length === 0 && /The owner decides here: https:\/\/\S+\/p\/0x/.test(text);
  failed ||= !ok;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${urlMode ? 'client with URL elicitation' : 'client without it'} (${String(Date.now() - started)} ms)`,
  );
  if (urlMode)
    console.log(`  asked: ${asked[0]?.message ?? '(nothing)'}\n  link:  ${asked[0]?.url ?? ''}`);
  console.log(`  answer: ${text.split('\n')[0] ?? ''}`);
  await client.close();
}
process.exit(failed ? 1 : 0);
