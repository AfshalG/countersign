/**
 * Connects to the deployed MCP server with the AI SDK's MCP client, through both
 * doors, and calls the tools directly (no model). Run: pnpm smoke [url]
 */
import { createMCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';

// The client types tool results loosely; read the text parts safely.
const callResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
const textOf = (result: unknown): string =>
  callResult
    .parse(result)
    .content.map((c) => c.text ?? `[${c.type}]`)
    .join(' ');

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const url = process.argv[2] ?? 'https://countersign-connector-spike.vercel.app/api/mcp';
const token = process.env.CONNECTOR_TEST_TOKEN;

setTimeout(() => {
  console.error('smoke test did not finish within 60 s');
  process.exit(1);
}, 60_000).unref();

async function viaDoor(door: 'open' | 'token' | 'wrong token') {
  const headers: Record<string, string> =
    door === 'token' && token
      ? { Authorization: `Bearer ${token}` }
      : door === 'wrong token'
        ? { Authorization: 'Bearer wrong' }
        : {};
  try {
    const client = await createMCPClient({ transport: { type: 'http', url, headers } });
    try {
      const { tools } = await client.listTools();
      const call = async (name: string, args: Record<string, unknown>) => {
        return textOf(await client.callTool({ name, arguments: args }));
      };
      const info = await call('connection_info', {});
      const clean = await call('check_payment', {
        supplier: 'Kalibre Studio',
        amount: 4200,
        payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEc',
      });
      const lookAlike = await call('check_payment', {
        supplier: 'Kalibre Studio',
        amount: 1200,
        payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEd',
      });
      return { door, tools: tools.map((t) => t.name), info, clean, lookAlike };
    } finally {
      await client.close();
    }
  } catch (error) {
    return {
      door,
      refused: error instanceof Error ? (error.message.split('\n')[0] ?? 'error') : String(error),
    };
  }
}

const results = [await viaDoor('open'), await viaDoor('token'), await viaDoor('wrong token')];
console.log(JSON.stringify(results, null, 2));
process.exit(0);
