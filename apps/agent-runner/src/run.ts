/**
 * Real agents pay the demo documents through Countersign's hosted MCP server (Slice 14): each
 * model, through OpenRouter, gets the MCP tools and a page reader, and the supplier's links. The
 * hosted server pays from the main demo account with the hosted agent's key (ERC-8004 agent 2066).
 * Each model gets its own run label, so its invoices are new. Free models by default (no credits).
 *
 *   pnpm --filter @countersign/agent-runner run-agents [model ...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createMCPClient } from '@ai-sdk/mcp';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { promptFor, readPageTool, runAgent, score, type Doc } from './scenario';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const apiKey = process.env.OPENROUTER_API_KEY;
const token = process.env.MCP_SERVER_TOKEN;
if (!apiKey || !token)
  throw new Error('set OPENROUTER_API_KEY and MCP_SERVER_TOKEN in the repo .env');

const MCP = 'https://countersign-mcp.vercel.app/api/mcp';
const SITE = 'https://countersign-supplier-demo.vercel.app';
const ACCOUNT = '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9';
const CASES = ['ks-1001', 'ks-1002', 'ks-1003', 'ks-1004', 'ks-1005', 'nw-77'];
const models = process.argv.length > 2 ? process.argv.slice(2) : ['google/gemma-4-31b-it:free'];
const batch = Date.now().toString(36).slice(-4).toUpperCase();

setTimeout(() => {
  console.error('the runs did not finish within 15 minutes');
  process.exit(1);
}, 900_000).unref();

const openrouter = createOpenRouter({ apiKey });
const client = await createMCPClient({
  transport: { type: 'http', url: MCP, headers: { Authorization: `Bearer ${token}` } },
});
const runs = [];
try {
  const mcpTools = await client.tools();
  for (const [i, modelId] of models.entries()) {
    const run = `${batch}${String(i)}`;
    const docs: Doc[] = [];
    for (const id of CASES) {
      const url = `${SITE}/invoices/${id}?account=${ACCOUNT}&run=${run}`;
      const d = (await (await fetch(`${url}&format=json`)).json()) as {
        number: string;
        payTo: string;
        case: { expect: { outcome: string; afterSlice10?: { outcome: string } } };
      };
      const expected = d.case.expect.afterSlice10?.outcome ?? d.case.expect.outcome;
      docs.push({
        id,
        url,
        number: d.number,
        printedPayTo: d.payTo,
        clean: expected === 'settled',
      });
    }
    console.log(`\n${modelId} (run ${run}): ${String(docs.length)} invoices`);
    const record = await runAgent({
      modelId,
      model: openrouter(modelId),
      tools: { ...mcpTools, read_page: readPageTool() },
      prompt: promptFor(docs.map((d) => d.url)),
    });
    const scored = score(record, docs);
    for (const s of scored)
      console.log(
        `  ${s.ok ? 'ok  ' : 'MISS'} ${s.id.padEnd(8)} ${s.outcome}${s.reason ? ` (${s.reason})` : ''}${s.obeyedHiddenAddress ? ', paid an address the invoice does not print' : ''}`,
      );
    console.log(
      `  ${String(record.steps)} steps, ${String(Math.round(record.ms / 1000))} s${record.error ? `, error: ${record.error}` : ''}`,
    );
    console.log(`  told the person: ${record.text.slice(0, 600).replace(/\n+/g, ' ')}`);
    runs.push({ modelId, run, docs, scored, record });
  }
} finally {
  await client.close();
}
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
const out = new URL(
  `../results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  import.meta.url,
);
writeFileSync(
  out,
  `${JSON.stringify({ mcp: MCP, site: SITE, account: ACCOUNT, runs }, null, 2)}\n`,
);
console.log(`\nresults: apps/agent-runner/results/${out.pathname.split('/').at(-1) ?? ''}`);
process.exit(0);
