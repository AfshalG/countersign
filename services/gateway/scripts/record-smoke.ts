/**
 * Slice 18's live check: a held payment and its refusal written on Monad, and the payment's record
 * verified against Monad's own RPC, as an auditor would.
 *
 * A fresh test account (made and funded by the gateway, about 0.09 MON) pays the demo site's
 * KS-1003 (a padded line): the checker holds it and the gateway writes the hold with
 * `recordDecision`; the owner refuses it with the test passkey and the gateway writes the refusal
 * with `recordDecisionByOwner`. Then the record is downloaded, verified with the SDK's
 * `verifyRecord`, and saved to results/. About 0.03 MON more; nothing is paid.
 *
 *   pnpm --filter @countersign/gateway exec tsx scripts/record-smoke.ts [gateway URL]
 */
import { writeFileSync } from 'node:fs';
import { Countersign, verifyRecord, type PaymentRecord } from '@countersign/sdk';
import { createTestAccount, decide } from '@countersign/sdk/test-account';

const gateway = (process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app').replace(
  /\/$/,
  '',
);
const SITE = 'https://countersign-supplier-demo.vercel.app';
const started = Date.now();
const log = (...a: unknown[]) => {
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)} s]`, ...a);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the record says of a decision's transaction beyond what is verified. */
const txOf = (d: { tx: unknown }) =>
  d.tx as { hash: string; final: boolean; status: string | null } | null;

const me = await createTestAccount({ gateway });
log(`test account ${me.account}`);
const cs = new Countersign({
  gateway,
  token: me.token,
  account: me.account,
  agentKey: me.agentKey,
});
const order = (await cs.orders())[0];
if (!order) throw new Error('the test account has no order');

const tag = Date.now().toString(36);
const url = `${SITE}/invoices/ks-1003?account=${me.account}&run=${tag}`;
const doc = (await (await fetch(`${url}&format=json`)).json()) as {
  number: string;
  totalUsdc: string;
  payTo: `0x${string}`;
};
const html = await (await fetch(url)).text();
const paid = await cs.pay({
  order,
  invoice: { number: doc.number, amount: doc.totalUsdc, payTo: doc.payTo, document: { html } },
  wait: { timeoutMs: 30_000, pollMs: 300 },
});
log(`KS-1003: ${paid.status} (${paid.reason ?? ''}), ${paid.id}`);
if (paid.status !== 'held') throw new Error(`expected a hold, got ${paid.status}`);

/** The record, once `count` decisions are final on Monad. */
async function recordWith(count: number): Promise<PaymentRecord> {
  for (let i = 0; i < 90; i++) {
    const r = await cs.record(paid.id);
    const final = r.decision.onChain.filter((d) => txOf(d)?.final === true);
    if (final.length >= count) return r;
    await sleep(1_000);
  }
  throw new Error(`fewer than ${String(count)} decisions final on Monad after 90 s`);
}

const afterHold = await recordWith(1);
log(`the checker's hold on Monad: ${afterHold.decision.onChain[0]?.tx?.hash ?? '?'}`);

const refused = await decide({ id: paid.id, action: 'refuse', ownerKey: me.ownerKey, gateway });
log(`the owner refused it: ${refused.status}`);
const record = await recordWith(2);
for (const d of record.decision.onChain)
  log(`  ${d.by} on Monad: ${d.tx?.hash ?? '?'} (${txOf(d)?.status ?? '?'})`);

const file = new URL(`../results/2026-10-08-record-ks-1003.json`, import.meta.url);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
log(`record saved: ${file.pathname}`);

const verified = await verifyRecord(record);
for (const c of verified.checks) log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check}: ${c.detail}`);
log(verified.ok ? 'The record matches Monad.' : 'The record does NOT match Monad.');
process.exit(verified.ok ? 0 : 1);
