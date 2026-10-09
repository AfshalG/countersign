/**
 * Live (9 Oct): the hosted checker's model questions, through the gateway's bank-transfer advice
 * (nothing is paid, no gas). Two invoices from the checker's disguised set: b03, a bank change "to
 * follow" that only the model can see, and b02, an honest "details unchanged". Run before and after
 * the checker with definitions deployed; the evidence says which questions were asked.
 *
 *   npx tsx scripts/criteria-smoke.ts <label>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Countersign } from '@countersign/sdk';
import { KALIBRE } from '../../../apps/supplier/lib/documents.js';
import { CASES, invoiceText } from '../../checker/scripts/disguised-invoices.js';

// A token given in the shell wins over the repo .env's (which can lag the one deployed).
const fromShell = process.env.GATEWAY_SERVICE_TOKEN;
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const token = fromShell ?? process.env.GATEWAY_SERVICE_TOKEN;
if (!token) throw new Error('set GATEWAY_SERVICE_TOKEN in the repo .env');
const label = process.argv[2] ?? 'run';
const gateway = 'https://gateway-production-e17a.up.railway.app';
// The demo account with Kalibre's bank account on file (Slice 17).
const account = '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9';
const cs = new Countersign({ gateway, token, account });

const order = (await cs.orders()).find((o) => o.payTo === KALIBRE.payTo);
if (!order) throw new Error('no Kalibre Studio order on the demo account');

const rows = [];
for (const id of ['b03', 'b02']) {
  const index = CASES.findIndex((c) => c.id === id);
  const c = CASES[index];
  if (!c) throw new Error(`no case ${id}`);
  // A number of its own per run, so the advice is a new record each time.
  const { text } = invoiceText(c, `KS-${String(2001 + index)}-${label.toUpperCase()}`);
  const started = Date.now();
  const res = await fetch(`${gateway}/v1/advice`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ account, vault: order.vault, document: { text } }),
  });
  const body = (await res.json()) as {
    advice?: string;
    reason?: string | null;
    evidence?: { model?: { answers?: Record<string, number>; criteria?: Record<string, unknown> } };
    error?: string;
  };
  const row = {
    case: id,
    about: c.about,
    status: res.status,
    advice: body.advice ?? body.error,
    reason: body.reason ?? null,
    answers: body.evidence?.model?.answers ?? null,
    definitionsSent: Object.keys(body.evidence?.model?.criteria ?? {}),
    ms: Date.now() - started,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const day = new Date().toISOString().slice(0, 10);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(
  new URL(`../results/${day}-criteria-live-${label}.json`, import.meta.url),
  `${JSON.stringify({ at: new Date().toISOString(), gateway, account, rows }, null, 2)}\n`,
);
