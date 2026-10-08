/**
 * Slice 16 live: a run of 200 invoices through the product, end to end. A new test account (as a
 * developer makes one) gets test USDC and ten orders with Kalibre Studio on its quote, approved
 * with its owner key. 200 invoices are read from the supplier's own pages: 170 clean, and six each
 * of a look-alike address, a padded line, a padded total, hidden instructions and an amount over
 * the limit. One agent submits them as one run through the SDK while a second agent submits 20 of
 * the same invoices at the same moment. The real checker reads every invoice. Then the largest
 * group of holds is refused with one passkey signature (D18). Writes results/<date>-run-200.json.
 * About 6 MON of relayer gas and 0.25 test USDC.
 *
 *   pnpm --filter @countersign/gateway run-200 [gateway URL] [--size 200]
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { chain, USDC } from '@countersign/chain';
import { loadEnv } from '@countersign/shared';
import { Countersign, type Order, type PayInput } from '@countersign/sdk';
import { createTestAccount, TestOwner } from '@countersign/sdk/test-account';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(z.object({ DEMO_FUNDER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }));
const gateway =
  process.argv.slice(2).find((a) => a.startsWith('http')) ??
  'https://gateway-production-e17a.up.railway.app';
const sizeAt = process.argv.indexOf('--size');
const SIZE = sizeAt === -1 ? 200 : Number(process.argv[sizeAt + 1]);
const SITE = 'https://countersign-supplier-demo.vercel.app';
const ORDERS = 10;
const DOCTORED = ['ks-1002', 'ks-1003', 'ks-1004', 'ks-1005', 'ks-1006'] as const;
const EACH = Math.max(1, Math.round(SIZE * 0.03)); // six of each kind in a run of 200
const SECOND_AGENT = 20;
const tag = Date.now().toString(36).slice(-3);
const log = (...a: unknown[]) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
};

type Doc = {
  number: string;
  totalUsdc: string;
  payTo: Hex;
  case: {
    expect: {
      outcome: string;
      reason?: string;
      afterSlice10?: { outcome: string; reason: string };
    };
  };
};
async function inBatches<T, R>(items: T[], size: number, work: (t: T, i: number) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map((t, j) => work(t, i + j)))));
  return out;
}
async function relayerMon(): Promise<number> {
  const h = (await (await fetch(`${gateway}/health`)).json()) as { relayers: { mon: string }[] };
  return h.relayers.reduce((n, r) => n + Number(r.mon), 0);
}

// 1. The account, its USDC and its orders.
let t = Date.now();
const me = await createTestAccount({ gateway });
log(`test account ${me.account} in ${String(Date.now() - t)} ms`);
const cs = new Countersign({
  gateway,
  token: me.token,
  account: me.account,
  agentKey: me.agentKey,
});
const owner = TestOwner.fromPrivateKey(me.ownerKey);
const perOrder = Math.ceil(SIZE / ORDERS) * 0.001 + 0.002;
const usdcNeeded = parseUnits((perOrder * ORDERS + 0.01).toFixed(6), 6);
const funder = privateKeyToAccount(env.DEMO_FUNDER_PRIVATE_KEY as Hex);
const reader = createPublicClient({ chain, transport: http() });
const fundTx = await createWalletClient({
  account: funder,
  chain,
  transport: http(),
}).writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [me.account, usdcNeeded],
});
await reader.waitForTransactionReceipt({ hash: fundTx });
log(`funded with ${(Number(usdcNeeded) / 1e6).toFixed(4)} USDC`);

const quoteUrl = (i: number) =>
  `${SITE}/quotes/q-2210?account=${me.account}&run=${tag}q${String(i)}`;
for (let i = 0; i < ORDERS; i++) {
  const text = await (await fetch(quoteUrl(i))).text();
  const p = await cs.proposeOrder({
    supplier: {
      name: 'Kalibre Studio',
      payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEc',
      website: SITE,
    },
    amount: perOrder.toFixed(4),
    expiry: Math.floor(Date.now() / 1000) + 14 * 86_400,
    document: text,
  });
  let view: { actions: Record<string, { challenge: Hex } | undefined> };
  for (;;) {
    view = (await (await fetch(`${gateway}/v1/approvals/${p.id}`)).json()) as typeof view;
    if (view.actions.approve_order) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const res = await fetch(`${gateway}/v1/approvals/${p.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'approve',
      assertions: {
        approve_order: owner.sign((view.actions.approve_order as { challenge: Hex }).challenge),
      },
    }),
  });
  if (!res.ok) throw new Error(`order ${String(i)}: ${String(res.status)} ${await res.text()}`);
}
let orders: Order[] = [];
for (let i = 0; i < 60 && orders.length < ORDERS; i++) {
  orders = (await cs.orders()).filter((o) => BigInt(o.remaining) >= 1_000n);
  if (orders.length < ORDERS) await new Promise((r) => setTimeout(r, 1_000));
}
log(`${String(orders.length)} orders open, ${perOrder.toFixed(4)} USDC each`);

// 2. The invoices, read from the supplier's pages as an agent would.
const plan = [
  ...DOCTORED.flatMap((id) => Array.from({ length: EACH }, () => id)),
  ...Array.from({ length: SIZE - EACH * DOCTORED.length }, () => 'ks-1001'),
].sort(() => Math.random() - 0.5);
t = Date.now();
const invoices = await inBatches(plan, 20, async (id, i) => {
  const page = `${SITE}/invoices/${id}?account=${me.account}&run=${tag}${String(i)}`;
  const doc = (await (await fetch(`${page}&format=json`)).json()) as Doc;
  const html = await (await fetch(page)).text();
  const expect = doc.case.expect.afterSlice10 ?? doc.case.expect;
  return { id, doc, html, expect: { outcome: expect.outcome, reason: expect.reason ?? null } };
});
log(`${String(invoices.length)} invoices read in ${String(Date.now() - t)} ms`);
const inputs: PayInput[] = invoices.map((inv, i) => ({
  order: orders[i % orders.length] as Order,
  invoice: {
    number: inv.doc.number,
    amount: inv.doc.totalUsdc,
    payTo: inv.doc.payTo,
    document: { html: inv.html },
  },
}));

// 3. Two agents at once: the run, and 20 of the same invoices from a second agent.
const second = new Countersign({
  gateway,
  token: me.token,
  account: me.account,
  agentKey: me.agentKey,
});
const resent = inputs.filter((_, i) => invoices[i]?.id === 'ks-1001').slice(0, SECOND_AGENT);
const monBefore = await relayerMon();
const started = Date.now();
const [run, again] = await Promise.all([cs.payMany(inputs), second.payMany(resent)]);
log(
  `submitted run ${run.runId} (${String(run.requests.length)}) and ${String(again.requests.length)} again from a second agent`,
);
const sameIds = again.requests.every((r) => run.requests.some((q) => q.id === r.id));

// 4. Watch it until every payment is decided.
type Summary = {
  decided: number;
  done: boolean;
  elapsedMs: number;
  settled: { count: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  held: { reason: string; count: number; ids: string[] }[];
  blocked: { reason: string; count: number }[];
};
type RunView = {
  summary: Summary;
  requests: { id: string; status: string; reason: string | null; tx: { hash: string | null } }[];
};
let view: RunView;
for (;;) {
  view = (await (
    await fetch(`${gateway}/v1/runs/${run.runId}`, {
      headers: { authorization: `Bearer ${me.token}` },
    })
  ).json()) as RunView;
  log(
    `${String(view.summary.decided)}/${String(SIZE)} decided, ${String(view.summary.settled.count)} paid`,
  );
  if (view.summary.done || Date.now() - started > 15 * 60_000) break;
  await new Promise((r) => setTimeout(r, 2_000));
}
const wallMs = Date.now() - started;
await new Promise((r) => setTimeout(r, 5_000)); // balances settle
const monSpent = monBefore - (await relayerMon());

// 5. Scored against what each document should end as.
const byId = new Map(view.requests.map((r) => [r.id, r]));
const scored = invoices.map((inv, i) => {
  const got = byId.get(run.requests[i]?.id ?? '');
  const outcome = got?.status ?? 'missing';
  return {
    case: inv.id,
    number: inv.doc.number,
    expected: inv.expect,
    outcome,
    reason: got?.reason ?? null,
  };
});
const doctored = scored.filter((s) => s.case !== 'ks-1001');
const clean = scored.filter((s) => s.case === 'ks-1001');
const caught = doctored.filter((s) => s.outcome === 'held' || s.outcome === 'blocked').length;
const wronglyHeld = clean.filter((s) => s.outcome !== 'settled');
const asExpected = scored.filter(
  (s) =>
    s.outcome === s.expected.outcome &&
    (s.expected.reason === null || s.expected.reason === s.reason),
).length;
const txs = new Set(view.requests.map((r) => r.tx.hash).filter((h) => h !== null));

// 6. Refuse the largest group of holds with one signature (D18).
let group: unknown = null;
const largest = view.summary.held[0];
if (largest) {
  const g = (await (
    await fetch(`${gateway}/v1/approvals/runs/${run.runId}?reason=${largest.reason}`)
  ).json()) as { challenge: Hex; count: number };
  const res = await fetch(`${gateway}/v1/approvals/runs/${run.runId}?reason=${largest.reason}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: owner.sign(g.challenge) }),
  });
  group = {
    reason: largest.reason,
    shown: g.count,
    status: res.status,
    ...((await res.json()) as object),
  };
  log(`refused the ${largest.reason} group with one signature:`, JSON.stringify(group));
}

const result = {
  date: new Date().toISOString(),
  gateway,
  account: me.account,
  runId: run.runId,
  board: `${gateway}/r/${run.runId}`,
  size: SIZE,
  orders: ORDERS,
  intakeToLastDecisionMs: view.summary.elapsedMs,
  wallClockMs: wallMs,
  settled: view.summary.settled,
  held: view.summary.held.map((g) => ({ reason: g.reason, count: g.count })),
  blocked: view.summary.blocked,
  doctored: { total: doctored.length, caught },
  clean: {
    total: clean.length,
    wronglyHeld: wronglyHeld.length,
    examples: wronglyHeld.slice(0, 5),
  },
  asExpected,
  secondAgent: { sent: resent.length, sameRequests: sameIds },
  transactions: txs.size,
  relayerMonSpent: Number(monSpent.toFixed(4)),
  groupRefusal: group,
  invoices: scored,
};
const file = new URL(
  `../results/${result.date.slice(0, 10)}-run-${String(SIZE)}.json`,
  import.meta.url,
);
writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
log(
  `done: ${String(SIZE)} invoices, last decision ${(view.summary.elapsedMs / 1000).toFixed(1)} s after intake; paid ${String(view.summary.settled.count)} (each p50 ${String(view.summary.settled.p50Ms)} ms, p95 ${String(view.summary.settled.p95Ms)} ms); doctored caught ${String(caught)}/${String(doctored.length)}; clean wrongly held ${String(wronglyHeld.length)}/${String(clean.length)}; ${String(asExpected)}/${String(SIZE)} as expected; second agent's ${String(resent.length)} were the same requests: ${String(sameIds)}; ${String(txs.size)} payment transactions; ${monSpent.toFixed(3)} MON`,
);
log(`board: ${result.board}`);
process.exit(0);
