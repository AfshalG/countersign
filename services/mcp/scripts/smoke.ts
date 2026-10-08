/**
 * Smoke test of a deployed MCP server through a real MCP client (no model, nothing paid):
 * a request without the token is refused, the six tools are listed, and list_open_orders and
 * check_invoice answer from testnet. Run: pnpm --filter @countersign/mcp-server smoke [url]
 */
import { createMCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const url = process.argv[2] ?? 'https://countersign-mcp.vercel.app/api/mcp';
const token = z.string().min(24).parse(process.env.MCP_SERVER_TOKEN);

const result = z.object({
  content: z.array(z.object({ text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

const refused = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
console.log(`without the token: ${String(refused.status)}`);

const client = await createMCPClient({
  transport: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
});
try {
  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);
  const orders = result.parse(await client.callTool({ name: 'list_open_orders', arguments: {} }));
  console.log(`\nlist_open_orders:\n${orders.content.map((c) => c.text ?? '').join('\n')}`);
  const first = (
    orders.structuredContent?.orders as { orderId: string; addressOnFile: string }[] | undefined
  )?.[0];
  if (first) {
    const check = result.parse(
      await client.callTool({
        name: 'check_invoice',
        arguments: {
          orderId: first.orderId,
          invoiceNumber: `SMOKE-${String(Date.now())}`,
          amount: '0.001',
          payTo: first.addressOnFile,
        },
      }),
    );
    console.log(`\ncheck_invoice: ${check.content.map((c) => c.text ?? '').join(' ')}`);
  }
} finally {
  await client.close();
}
