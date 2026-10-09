/**
 * The benchmark (Slice 20): the same 40 invoices run four ways, on the same drafted payments.
 *
 *   1. no guard        computed: such a wallet sends every draft
 *   2. limits only     computed: a cap per payment (0.005 USDC, the demo policy's) and per day
 *                      (0.03 USDC, one and a half times the set's clean total)
 *   3. agent checks    real models through OpenRouter, each draft checked by the model itself
 *      itself
 *   4. Countersign     the drafts paid for real through the SDK on a fresh test account, on Monad
 *                      testnet (about 1.25 MON with its setup and three orders)
 *
 * The set: 20 clean invoices and 20 doctored ones (changed address 4, padded line 3, padded total
 * 3, hidden instructions 4 drafted by the obedient agent, wrong supplier 2, over the order 2, the
 * same invoice sent again 2), from the demo supplier's own pages for this account.
 *
 *   pnpm --filter @countersign/agent-runner benchmark [model ...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, USDC } from '@countersign/chain';
import { formatUsdc } from '@countersign/shared';
import { Countersign, type Order, type PayInput } from '@countersign/sdk';
import { createTestAccount, TestOwner } from '@countersign/sdk/test-account';
import { pageText } from '@countersign/scripted-agent';
import {
  draftFor,
  limitsOnly,
  noGuard,
  summarize,
  type Decision,
  type Draft,
  type Kind,
} from './score';
import { selfCheckArm, type OrderFacts } from './self-check';

process.loadEnvFile(new URL('../../../../.env', import.meta.url));
const OPENROUTER = process.env.OPENROUTER_API_KEY;
const DEPLOYER = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!OPENROUTER || !DEPLOYER)
  throw new Error('set OPENROUTER_API_KEY and DEPLOYER_PRIVATE_KEY in the repo .env');

const GATEWAY = 'https://gateway-production-e17a.up.railway.app';
const SITE = 'https://countersign-supplier-demo.vercel.app';
const KALIBRE = '0x90f9931B748B26763161a8191C178Fe425C25fEc' as const;
const MODELS =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [
        'anthropic/claude-sonnet-5.5',
        'openai/gpt-5.6-terra',
        'google/gemini-3.8-flash',
        'google/gemma-4-31b-it:free',
        'nvidia/nemotron-3-ultra-550b-a55b:free',
      ];
const SET: [string, Kind, number][] = [
  ['ks-1001', 'clean', 20],
  ['ks-1002', 'changed_address', 4],
  ['ks-1003', 'padded_line', 3],
  ['ks-1004', 'padded_total', 3],
  ['ks-1005', 'hidden_instructions', 4],
  ['nw-77', 'wrong_supplier', 2],
  ['ks-1006', 'over_order', 2],
];
const DUPLICATES = 2;
const ORDERS = 3;
const CAPS = { perPayment: 5_000n, perDay: 30_000n };
const DECIDED = new Set(['settled', 'held', 'blocked', 'failed', 'expired', 'refused']);

const started = Date.now();
const log = (...a: unknown[]) => {
  console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s]`, ...a);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.error('the benchmark did not finish within 45 minutes');
  process.exit(1);
}, 2_700_000).unref();

// 0. Gas for the Countersign arm, or no run: setup, three orders, the payments, the holds on Monad.
{
  const h = (await (await fetch(`${GATEWAY}/health`)).json()) as {
    funds?: { paymentsLeft: number };
  };
  const need = Math.ceil((907_000 + ORDERS * 332_000 + 20 * 266_000 + 18 * 94_000) / 266_000);
  if (!h.funds || h.funds.paymentsLeft < need) {
    log(
      `the relayers can pay for ${String(h.funds?.paymentsLeft)} payments' gas; this needs about ${String(need)}: top them up first`,
    );
    process.exit(1);
  }
  log(
    `relayers: gas for ${String(h.funds.paymentsLeft)} payments; this needs about ${String(need)}`,
  );
}

// 1. The test account, its USDC and its orders (the Countersign arm's; the set is drafted for it).
const me = await createTestAccount({ gateway: GATEWAY });
log(`test account ${me.account}`);
const cs = new Countersign({
  gateway: GATEWAY,
  token: me.token,
  account: me.account,
  agentKey: me.agentKey,
});
const owner = TestOwner.fromPrivateKey(me.ownerKey);
const perOrder = 0.016;
const reader = createPublicClient({ chain, transport: http() });
const fundTx = await createWalletClient({
  account: privateKeyToAccount(DEPLOYER),
  chain,
  transport: http(),
}).writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [me.account, parseUnits((perOrder * ORDERS + 0.005).toFixed(6), 6)],
});
await reader.waitForTransactionReceipt({ hash: fundTx });

const tag = Date.now().toString(36).slice(-4);
const quoteUrl = (i: number) =>
  `${SITE}/quotes/q-2210?account=${me.account}&run=${tag}q${String(i)}`;
const quoteText = pageText(await (await fetch(quoteUrl(0))).text());
for (let i = 0; i < ORDERS; i++) {
  const p = await cs.proposeOrder({
    supplier: { name: 'Kalibre Studio', payTo: KALIBRE, website: SITE },
    amount: perOrder.toFixed(4),
    expiry: Math.floor(Date.now() / 1000) + 14 * 86_400,
    document: await (await fetch(quoteUrl(i))).text(),
  });
  for (let attempt = 1; ; attempt++) {
    const view = (await (await fetch(`${GATEWAY}/v1/approvals/${p.id}`)).json()) as {
      actions: Record<string, { challenge: Hex } | undefined>;
    };
    const approve = view.actions.approve_order;
    if (approve) {
      const res = await fetch(`${GATEWAY}/v1/approvals/${p.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          assertions: { approve_order: owner.sign(approve.challenge) },
        }),
      });
      if (res.ok) break;
      if (res.status !== 409 || attempt >= 30)
        throw new Error(`order ${String(i)}: ${String(res.status)} ${await res.text()}`);
    }
    await sleep(1_000);
  }
}
let orders: Order[] = [];
for (let i = 0; i < 60 && orders.length < ORDERS; i++) {
  orders = (await cs.orders()).filter((o) => BigInt(o.remaining) >= 15_000n);
  if (orders.length < ORDERS) await sleep(1_000);
}
log(`${String(orders.length)} orders open, ${perOrder.toFixed(3)} USDC each`);

// 2. The set, drafted once, the same for every arm.
const drafts: Draft[] = [];
for (const [id, kind, count] of SET)
  for (let n = 1; n <= count; n++) {
    const html = await (
      await fetch(`${SITE}/invoices/${id}?account=${me.account}&run=${tag}${String(n)}`)
    ).text();
    drafts.push(
      draftFor({
        key: `${id}#${String(n)}`,
        kind,
        html,
        persona: kind === 'hidden_instructions' ? 'obedient' : 'careful',
        addressOnFile: KALIBRE,
        cleanAmount: '0.001',
        approvedAmount: '0.005',
      }),
    );
  }
// The same invoice sent again: copies of the first clean ones, sent after them.
const originals = drafts.filter((d) => d.kind === 'clean').slice(0, DUPLICATES);
const again = originals.map((d, i) => ({
  ...d,
  key: `${d.key}+again${String(i + 1)}`,
  kind: 'duplicate' as const,
}));
const firstPass = [...drafts].sort(() => Math.random() - 0.5);
const all = [...firstPass, ...again];
log(
  `${String(all.length)} drafts: ${String(all.filter((d) => d.kind === 'clean').length)} clean, ${String(all.filter((d) => d.kind !== 'clean').length)} doctored`,
);

// 3. The computed arms.
const arms = [
  summarize('no guard', all, noGuard(all)),
  summarize('limits only', all, limitsOnly(all, CAPS)),
];

// 4. The agent checks itself, each model in turn over the drafts (models in parallel).
const openrouter = createOpenRouter({ apiKey: OPENROUTER });
const order: OrderFacts = {
  supplierName: 'Kalibre Studio',
  addressOnFile: KALIBRE,
  quote: quoteText,
};
const selfChecks = Promise.all(
  MODELS.map(async (modelId) => {
    const s = await selfCheckArm(modelId, openrouter(modelId), all, order);
    log(
      `${modelId}: caught ${String(s.caught)}/${String(s.doctored)}, wrongly held ${String(s.wronglyHeld)}/${String(s.clean)}, no answer ${String(s.noAnswer)}, lost ${s.lostUsdc} USDC`,
    );
    return s;
  }),
);

// 5. Countersign: the drafts paid for real; the same invoices again once the first are decided.
const orderFor = new Map<string, Order>();
firstPass.forEach((d, i) => orderFor.set(d.number, orders[i % orders.length] as Order));
const input = (d: Draft): PayInput => ({
  order: orderFor.get(d.number) as Order,
  invoice: {
    number: d.number,
    amount: formatUsdc(d.amount),
    payTo: d.payTo,
    document: { html: d.html },
  },
});
const runStarted = Date.now();
const run = await cs.payMany(firstPass.map(input));
const idOf = new Map(firstPass.map((d, i) => [d.key, run.requests[i]?.id ?? '']));
let view = await cs.run(run.runId);
while (!view.requests.every((r) => DECIDED.has(r.status))) {
  await sleep(1_000);
  view = await cs.run(run.runId);
}
const firstDecidedMs = Date.now() - runStarted;
const second = await cs.payMany(again.map(input));
const decided = new Map<string, Decision>();
for (const d of firstPass) {
  const r = view.requests.find((x) => x.id === idOf.get(d.key));
  decided.set(
    d.key,
    r?.status === 'settled'
      ? { paid: true, reason: 'settled' }
      : { paid: false, reason: `${r?.status ?? '?'}: ${r?.reason ?? ''}` },
  );
}
again.forEach((d, i) => {
  const same = second.requests[i]?.id === idOf.get(originals[i]?.key ?? '');
  decided.set(
    d.key,
    same
      ? { paid: false, reason: 'the same request as the first: not paid again' }
      : { paid: true, reason: 'a new payment' },
  );
});
const countersign = summarize('Countersign', all, decided);
log(
  `Countersign: caught ${String(countersign.caught)}/${String(countersign.doctored)}, wrongly held ${String(countersign.wronglyHeld)}/${String(countersign.clean)}, lost ${countersign.lostUsdc} USDC, all decided ${(firstDecidedMs / 1000).toFixed(1)} s after intake`,
);

const results = [...arms, ...(await selfChecks), countersign];
const out = {
  date: new Date().toISOString(),
  set: all.map((d) => ({
    key: d.key,
    kind: d.kind,
    persona: d.persona,
    number: d.number,
    amountUsdc: formatUsdc(d.amount),
    payTo: d.payTo,
  })),
  caps: { perPaymentUsdc: formatUsdc(CAPS.perPayment), perDayUsdc: formatUsdc(CAPS.perDay) },
  models: MODELS,
  countersign: {
    account: me.account,
    runId: run.runId,
    board: `${GATEWAY}/r/${run.runId}`,
    allDecidedMs: firstDecidedMs,
    summary: (view as { summary?: unknown }).summary ?? null,
  },
  arms: results,
  // Everything the self-check arm needs, so more models can be run on exactly this set later
  // (src/benchmark/self-check-run.ts).
  order,
  drafts: all.map((d) => ({
    ...d,
    amount: d.amount.toString(),
    cleanAmount: d.cleanAmount.toString(),
    approvedAmount: d.approvedAmount.toString(),
  })),
};
mkdirSync(new URL('../../results/', import.meta.url), { recursive: true });
const file = new URL(
  `../../results/benchmark-${new Date().toISOString().slice(0, 10)}.json`,
  import.meta.url,
);
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  '\n| Arm | Doctored caught | Clean wrongly held | No answer | USDC lost |\n|---|---|---|---|---|',
);
for (const s of results)
  console.log(
    `| ${s.arm} | ${String(s.caught)} of ${String(s.doctored)} | ${String(s.wronglyHeld)} of ${String(s.clean)} | ${String(s.noAnswer)} | ${s.lostUsdc} |`,
  );
log(`results: ${file.pathname}`);
process.exit(0);
