/**
 * More models for the benchmark's "agent checks itself" arm, on exactly the set a benchmark run
 * saved (Slice 20): the same drafts, in the same order, with the same order facts. Each model's arm
 * replaces any earlier one of the same model in the file.
 *
 *   pnpm --filter @countersign/agent-runner exec tsx src/benchmark/self-check-run.ts <results.json> <model> [model ...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ArmSummary, Draft } from './score';
import { selfCheckArm, type OrderFacts } from './self-check';

process.loadEnvFile(new URL('../../../../.env', import.meta.url));
const apiKey = process.env.OPENROUTER_API_KEY;
const [file, ...models] = process.argv.slice(2);
if (!apiKey || !file || models.length === 0)
  throw new Error(
    'usage: self-check-run.ts <results.json> <model> [model ...] (OPENROUTER_API_KEY in .env)',
  );

type Saved = Omit<Draft, 'amount' | 'cleanAmount' | 'approvedAmount'> & {
  amount: string;
  cleanAmount: string;
  approvedAmount: string;
};
const results = JSON.parse(readFileSync(file, 'utf8')) as {
  order: OrderFacts;
  drafts: Saved[];
  arms: ArmSummary[];
  models: string[];
};
const drafts: Draft[] = results.drafts.map((d) => ({
  ...d,
  amount: BigInt(d.amount),
  cleanAmount: BigInt(d.cleanAmount),
  approvedAmount: BigInt(d.approvedAmount),
}));
const openrouter = createOpenRouter({ apiKey });
const arms = await Promise.all(
  models.map((m) => selfCheckArm(m, openrouter(m), drafts, results.order)),
);
for (const a of arms) {
  results.arms = results.arms.filter((x) => x.arm !== a.arm);
  // Before the Countersign arm, which stays last.
  results.arms.splice(Math.max(0, results.arms.length - 1), 0, a);
  console.log(
    `${a.arm}: caught ${String(a.caught)}/${String(a.doctored)}, wrongly held ${String(a.wronglyHeld)}/${String(a.clean)}, no answer ${String(a.noAnswer)}, lost ${a.lostUsdc} USDC`,
  );
}
results.models = [...new Set([...results.models, ...models])];
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
