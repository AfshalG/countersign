/**
 * The checker with the real model (Jev on OpenRouter) on every demo invoice (Slice 10), each paid
 * as printed, against its supplier's order and quote, as the gateway would send it. The contract
 * rules the gateway checks first are not run here: this is the checker alone. Writes the answers
 * to results/. Costs about $0.0001 in all.
 *
 *   pnpm --filter @countersign/checker demo-with-jev
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import { invoiceHash, supplierId, supplierSlug, usdc } from '@countersign/shared';
import { CASES, documentFor, FIELDSTONE, KALIBRE } from '../../../apps/supplier/lib/documents';
import { asText, render } from '../../../apps/supplier/lib/render';
import { check, type CheckInput } from '../src/check.js';
import { JevModel } from '../src/model.js';
import { keySigner } from '../src/sign.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('set OPENROUTER_API_KEY in the repo .env');
const model = new JevModel(key);
const signer = keySigner(generatePrivateKey());
const ACCOUNT = '0x8f1431D15E547a1073b064e73F0C61372CcEA739';
const VAULT = '0x6c033066C05Eb524119c8C830F937C4bbd17E426';
const kalibre = {
  supplierId: supplierId(supplierSlug('Kalibre Studio')),
  supplierName: 'Kalibre Studio',
  addressOnFile: KALIBRE.payTo,
  quote: { html: render(documentFor('q-2210', ACCOUNT)) },
};
const fieldstone = {
  supplierId: supplierId(supplierSlug('Fieldstone Supply')),
  supplierName: 'Fieldstone Supply',
  addressOnFile: FIELDSTONE.payTo,
  quote: null,
};

const rows = [];
for (const c of CASES.filter((x) => x.kind !== 'quote')) {
  for (const format of ['html', 'text'] as const) {
    const d = documentFor(c.id, ACCOUNT);
    // Each invoice is paid against its party's order: Northwind's against Kalibre's (the agent's mistake).
    const order = c.party === 'fieldstone' ? fieldstone : kalibre;
    const input: CheckInput = {
      payment: {
        chainId: 10143,
        vault: VAULT,
        amount: usdc(d.totalUsdc),
        invoiceHash: invoiceHash(order.supplierId, d.number),
        payTo: d.payTo,
        deadline: 2_000_000_000n,
      },
      order,
      invoice: format === 'html' ? { html: render(d) } : { text: asText(d) },
    };
    const r = await check(input, { model, signer });
    const failed = r.evidence.findings.find((f) => !f.ok);
    rows.push({
      case: c.id,
      format,
      verdict: r.verdict,
      reason: r.verdict === 'hold' ? r.reason : null,
      decidedBy: failed ? `code: ${failed.check}` : r.evidence.model ? 'model' : 'error',
      answers: r.evidence.model?.answers ?? null,
      model: r.evidence.model?.name ?? null,
      ms: r.evidence.ms,
    });
    const last = rows.at(-1);
    console.log(
      `${c.id.padEnd(15)} ${format.padEnd(5)} ${r.verdict.padEnd(8)} ${(last?.reason ?? '').padEnd(20)} ${String(last?.decidedBy).padEnd(18)} ${JSON.stringify(last?.answers ?? {})} ${String(r.evidence.ms)} ms`,
    );
  }
}
const day = new Date().toISOString().slice(0, 10);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(
  new URL(`../results/${day}-demo-with-jev.json`, import.meta.url),
  `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`,
);
console.log(`results/${day}-demo-with-jev.json`);
