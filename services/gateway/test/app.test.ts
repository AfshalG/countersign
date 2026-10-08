import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { generatePrivateKey } from 'viem/accounts';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

let database: Database;
let store: Store;
let chain: FakeChain;
let app: ReturnType<typeof createApp>;
const TOKEN = 'test-service-token-0123456789';

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  chain = new FakeChain();
  app = createApp({
    store,
    chain,
    checker: new TestChecker(generatePrivateKey(), 10143),
    chainId: 10143,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    health: () => Promise.resolve({ relayers: [] }),
  });
});

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const payment = (invoice: string, amount = '1000') => ({
  amount,
  invoiceHash: keccak256(toHex(invoice)),
  payTo: SUPPLIER,
  deadline: 1_791_400_000,
});
const submit = (body: unknown) =>
  app.request('/v1/payments', { method: 'POST', headers: auth, body: JSON.stringify(body) });
const ownerAuth = {
  r: `0x${'11'.repeat(32)}`,
  s: `0x${'22'.repeat(32)}`,
  challengeIndex: '23',
  typeIndex: '1',
  authenticatorData: `0x${'33'.repeat(37)}`,
  clientDataJSON: '{"type":"webauthn.get"}',
};

async function heldRequest(invoice: string): Promise<string> {
  const res = await submit({
    account: ACCOUNT,
    vault: VAULT,
    payment: payment(invoice),
    agentSig: AGENT_SIG,
  });
  const { request } = (await res.json()) as { request: { id: string } };
  await store.transition(request.id, 'requested', 'checking');
  await store.transition(request.id, 'checking', 'held', {
    reason: 'items_mismatch',
    decidedBy: 'checker',
  });
  return request.id;
}

describe('POST /v1/payments', () => {
  it('creates a request and returns it, then returns the same request for the same invoice', async () => {
    const body = {
      account: ACCOUNT,
      vault: VAULT,
      payment: payment('INV-api'),
      agentSig: AGENT_SIG,
    };
    const first = await submit(body);
    expect(first.status).toBe(201);
    const a = (await first.json()) as { created: boolean; request: { id: string; status: string } };
    expect(a.created).toBe(true);
    expect(a.request.status).toBe('requested');
    const again = await submit(body);
    expect(again.status).toBe(200);
    const b = (await again.json()) as { created: boolean; request: { id: string } };
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
  });

  it('refuses a malformed body with a typed error, never a stack trace', async () => {
    const res = await submit({
      account: 'not an address',
      vault: VAULT,
      payment: payment('x'),
      agentSig: '0x12',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('malformed');
  });

  it('refuses a zero amount', async () => {
    const res = await submit({
      account: ACCOUNT,
      vault: VAULT,
      payment: payment('INV-0', '0'),
      agentSig: AGENT_SIG,
    });
    expect(res.status).toBe(400);
  });

  it('needs the service token', async () => {
    const res = await app.request('/v1/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const wrong = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...auth, authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
  });
});

describe('GET /v1/payments/:id', () => {
  it('returns status, reason, transaction and timings', async () => {
    const id = await heldRequest('INV-view');
    const res = await app.request(`/v1/payments/${id}`, { headers: auth });
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      status: string;
      reason: string;
      decidedBy: string;
      tx: unknown;
      timings: { checkMs: number | null };
    };
    expect(view.status).toBe('held');
    expect(view.reason).toBe('items_mismatch');
    expect(view.decidedBy).toBe('checker');
    expect(view).toHaveProperty('tx');
    expect(view.timings).toHaveProperty('checkMs');
  });

  it('answers unknown_request for an id it does not know', async () => {
    const res = await app.request(`/v1/payments/0x${'00'.repeat(32)}`, { headers: auth });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('unknown_request');
  });
});

describe('runs', () => {
  it('takes many invoices at once, as one run, and reports its progress', async () => {
    const payments = Array.from({ length: 5 }, (_, i) => ({
      vault: VAULT,
      payment: payment(`INV-run-${String(i)}`),
      agentSig: AGENT_SIG,
    }));
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ account: ACCOUNT, payments }),
    });
    expect(res.status).toBe(201);
    const { runId, requests } = (await res.json()) as { runId: string; requests: { id: string }[] };
    expect(requests).toHaveLength(5);
    const again = await app.request('/v1/runs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ account: ACCOUNT, payments }),
    });
    expect(((await again.json()) as { runId: string }).runId).toBe(runId);
    const progress = await app.request(`/v1/runs/${runId}`, { headers: auth });
    const summary = (await progress.json()) as { size: number; byStatus: Record<string, number> };
    expect(summary.size).toBe(5);
    expect(summary.byStatus.requested).toBe(5);
  });
});

describe('approving and refusing a held payment', () => {
  it('releases a held payment the owner pays once with the passkey', async () => {
    const id = await heldRequest('INV-approve');
    const res = await app.request(`/v1/payments/${id}/approve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ownerAuth }),
    });
    expect(res.status).toBe(200);
    const row = await store.get(id);
    expect(row?.status).toBe('released');
    expect(row?.decidedBy).toBe('user_once');
    // Stored as owner signatures (D36): this account's only owner is owner 0.
    expect(row?.ownerAuth).toMatchObject([{ owner: 0, auth: { challengeIndex: '23' } }]);
  });

  it('keeps the payment held when the passkey signature is not the owner’s', async () => {
    chain.ownerKeyValid = false;
    const id = await heldRequest('INV-badkey');
    const res = await app.request(`/v1/payments/${id}/approve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ownerAuth }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_passkey');
    expect((await store.get(id))?.status).toBe('held');
  });

  it('refuses a held payment with the owner’s passkey, which ends it', async () => {
    const id = await heldRequest('INV-refuse');
    const decision = {
      reasonHash: keccak256(toHex('not ours')),
      evidenceHash: keccak256(toHex('INV.pdf')),
    };
    const res = await app.request(`/v1/payments/${id}/refuse`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ownerAuth, decision }),
    });
    expect(res.status).toBe(200);
    const row = await store.get(id);
    expect(row?.status).toBe('refused');
    expect(row?.reason).toBe('user_refused');
    expect(row?.decidedBy).toBe('user_refused');
  });

  it('answers not_held for a payment that is not waiting for a person', async () => {
    const res = await submit({
      account: ACCOUNT,
      vault: VAULT,
      payment: payment('INV-nothold'),
      agentSig: AGENT_SIG,
    });
    const { request } = (await res.json()) as { request: { id: string } };
    const approve = await app.request(`/v1/payments/${request.id}/approve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ownerAuth }),
    });
    expect(approve.status).toBe(409);
    expect(((await approve.json()) as { error: string }).error).toBe('not_held');
  });
});

describe('GET /health and the feed', () => {
  it('reports the database without needing the token', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { db: boolean }).db).toBe(true);
  });

  it('streams status changes as server-sent events', async () => {
    const res = await app.request('/v1/feed', { headers: auth });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (!reader) throw new Error('no stream');
    await submit({
      account: ACCOUNT,
      vault: VAULT,
      payment: payment('INV-feed'),
      agentSig: AGENT_SIG,
    });
    let text = '';
    const deadline = Date.now() + 2_000;
    while (!text.includes('"to":"requested"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain('event: status');
    expect(text).toContain('"to":"requested"');
  });
});
