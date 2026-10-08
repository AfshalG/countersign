import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { invoiceHash, supplierId, supplierSlug } from '@countersign/shared';
import { documentFor, KALIBRE } from '../../../apps/supplier/lib/documents';
import { render } from '../../../apps/supplier/lib/render';
import { createApp } from '../src/app.js';
import type { Model, Question } from '../src/model.js';
import { keySigner } from '../src/sign.js';

const TOKEN = 'checker-token-0123456789abcdef';
const ACCOUNT = '0x8f1431D15E547a1073b064e73F0C61372CcEA739';
const KALIBRE_ID = supplierId(supplierSlug('Kalibre Studio'));
const fine: Model = {
  name: 'fake',
  ask: (_s: unknown, qs: readonly Question[]) =>
    Promise.resolve({
      answers: Object.fromEntries(
        qs.map((q) => [q.key, q.key === 'same_supplier' || q.key === 'on_order' ? 0.95 : 0.05]),
      ),
      model: 'fake-v1',
    }),
};
const signer = keySigner(generatePrivateKey());
const app = createApp({ token: TOKEN, model: fine, signer });
const d = documentFor('ks-1001', ACCOUNT);
const body = {
  payment: {
    chainId: 10143,
    vault: '0x6c033066C05Eb524119c8C830F937C4bbd17E426',
    amount: '1000',
    invoiceHash: invoiceHash(KALIBRE_ID, d.number),
    payTo: d.payTo,
    deadline: 2_000_000_000,
  },
  order: {
    supplierId: KALIBRE_ID,
    supplierName: 'Kalibre Studio',
    addressOnFile: KALIBRE.payTo,
    quote: { html: render(documentFor('q-2210', ACCOUNT)) },
  },
  invoice: { html: render(d) },
};
const post = (b: unknown, token = TOKEN) =>
  app.request('/v1/check', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });

describe('the checker over HTTP (the spec, D33)', () => {
  it('checks and signs a clean invoice', async () => {
    const res = await post(body);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { verdict: string; checkerSig: string };
    expect(out.verdict).toBe('release');
    expect(out.checkerSig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('answers a hold with its reason and evidence', async () => {
    const res = await post({ ...body, payment: { ...body.payment, amount: '2000' } });
    expect(await res.json()).toMatchObject({
      verdict: 'hold',
      reason: 'amount_mismatch',
      evidence: { findings: expect.any(Array) as unknown[] },
    });
  });

  it('refuses a missing or wrong token, and a malformed request', async () => {
    expect((await post(body, 'wrong-token-0123456789abcdef')).status).toBe(401);
    const bad = await post({ ...body, invoice: {} });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'malformed' });
  });

  it('says who it is and which key it signs with, without a token', async () => {
    const res = await app.request('/health');
    expect(await res.json()).toMatchObject({ ok: true, signer: signer.address, model: 'fake' });
    expect((await app.request('/openapi.json')).status).toBe(200);
  });
});
