/**
 * Runs the payment scenario on one model per family through OpenRouter, using our
 * MCP server's tools via the AI SDK. Run: pnpm agent [mcp-url] [model ...]
 * Needs OPENROUTER_API_KEY. Writes results to agent/results/<time>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createMCPClient } from '@ai-sdk/mcp';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { runScenario, summarise } from './scenario';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set in .env');
const token = process.env.CONNECTOR_TEST_TOKEN;
const url = process.argv[2] ?? 'https://countersign-connector-spike.vercel.app/api/mcp';
const FAMILIES = ['openai/', 'anthropic/', 'x-ai/', 'google/', 'meta-llama/', 'qwen/'];

setTimeout(() => {
  console.error('agent runs did not finish within 10 minutes');
  process.exit(1);
}, 600_000).unref();

/** The newest tool-capable model in each family, from OpenRouter's live list. */
async function pickModels(): Promise<string[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models?supported_parameters=tools');
  if (!res.ok) throw new Error(`OpenRouter model list: HTTP ${String(res.status)}`);
  const body = (await res.json()) as { data: { id: string; created: number }[] };
  return FAMILIES.flatMap((prefix) => {
    const newest = body.data
      .filter((m) => m.id.startsWith(prefix) && !m.id.includes(':free'))
      .sort((a, b) => b.created - a.created)[0];
    return newest ? [newest.id] : [];
  });
}

const models = process.argv.length > 3 ? process.argv.slice(3) : await pickModels();
const openrouter = createOpenRouter({ apiKey });
const client = await createMCPClient({
  transport: { type: 'http', url, headers: token ? { Authorization: `Bearer ${token}` } : {} },
});
try {
  const tools = await client.tools();
  const records = [];
  for (const modelId of models) {
    const record = await runScenario({ modelId, model: openrouter(modelId), tools });
    records.push(record);
    console.log(JSON.stringify(summarise(record)));
  }
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  const out = new URL(
    `./results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    import.meta.url,
  );
  writeFileSync(out, `${JSON.stringify({ url, models, records }, null, 2)}\n`);
  console.log(`saved ${out.pathname}`);
} finally {
  await client.close();
}
process.exit(0);
