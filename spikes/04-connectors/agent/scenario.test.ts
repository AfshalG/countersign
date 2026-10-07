import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { checkPayment, checkPaymentInput, KNOWN_SUPPLIERS } from '../lib/tools';
import { INVOICES, runScenario, summarise } from './scenario';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

// The same tool the MCP server exposes, wired locally: no network, no model provider.
const localTools = {
  check_payment: tool({
    description: 'Check a payment against what the business approved.',
    inputSchema: checkPaymentInput,
    execute: (input) => Promise.resolve(checkPayment(input)),
  }),
};

function scriptedModel(finalText: string) {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: INVOICES.map((inv, i) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${String(i)}`,
          toolName: 'check_payment',
          input: JSON.stringify({ supplier: inv.supplier, amount: inv.amount, payTo: inv.payTo }),
        })),
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text' as const, text: finalText }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
}

describe('the scenario', () => {
  it('has one clean invoice and two that must be held', () => {
    expect(INVOICES).toHaveLength(3);
    expect(INVOICES[0].payTo).toBe(KNOWN_SUPPLIERS[0].payTo);
  });

  it('records every check the model makes and what each returned', async () => {
    const record = await runScenario({
      modelId: 'mock',
      model: scriptedModel('Paid 1, held 2.'),
      tools: localTools,
    });
    expect(record.toolCalls.map((c) => c.toolName)).toEqual([
      'check_payment',
      'check_payment',
      'check_payment',
    ]);
    expect(record.results.map((r) => r.status)).toEqual(['settled', 'held', 'held']);
    expect(record.text).toBe('Paid 1, held 2.');
  });

  it('summarises a run: checked all three, two held, and whether the reply mentions the approval link', async () => {
    const record = await runScenario({
      modelId: 'mock',
      model: scriptedModel(
        'Two payments are held: approve at https://countersign-passkey-spike.vercel.app/',
      ),
      tools: localTools,
    });
    expect(summarise(record)).toEqual({
      modelId: 'mock',
      checks: 3,
      held: 2,
      settled: 1,
      mentionsApprovalLink: true,
      error: null,
    });
  });

  it('records a model that never calls the tool as zero checks, not as a pass', async () => {
    const lazy = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'All paid.' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      },
    });
    const record = await runScenario({ modelId: 'lazy', model: lazy, tools: localTools });
    expect(summarise(record)).toMatchObject({ checks: 0, held: 0, mentionsApprovalLink: false });
  });
});
