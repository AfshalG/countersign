import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import type { PaymentRequestRow } from '../src/db/schema.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { hashToken } from '../src/api/account-tokens.js';
import { runSummary } from '../src/runs.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

/** Slice 16: a run of many invoices, as the run board and its numbers see it. */
let database: Database;
let store: Store;
let app: ReturnType<typeof createApp>;
const TOKEN = 'test-service-token-0123456789';
const MINE = `cs_${'m'.repeat(43)}`;
const OTHER: Address = '0x1111111111111111111111111111111111111111';

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  app = createApp({
    store,
    chain: new FakeChain(),
    checker: new TestChecker(generatePrivateKey(), 10143),
    chainId: 10143,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
  });
  await store.issueApiToken(ACCOUNT, hashToken(MINE), 0);
});

const T0 = new Date('2026-10-08T21:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
function row(over: Partial<PaymentRequestRow>): PaymentRequestRow {
  return {
    id: keccak256(toHex(String(Math.random()))),
    runId: 'run',
    account: ACCOUNT,
    vault: VAULT,
    invoiceHash: keccak256(toHex(String(Math.random()))),
    payTo: SUPPLIER,
    amount: '1000',
    deadline: 1_791_400_000,
    agentSig: AGENT_SIG,
    agentAddress: null,
    document: null,
    status: 'requested',
    reason: null,
    decidedBy: null,
    evidence: null,
    checkerSig: null,
    ownerAuth: null,
    relayer: null,
    relayerNonce: null,
    rawTx: null,
    txHash: null,
    blockNumber: null,
    requestedAt: T0,
    checkedAt: null,
    decidedAt: null,
    sentAt: null,
    proposedAt: null,
    votedAt: null,
    finalizedAt: null,
    updatedAt: T0,
    leaseUntil: null,
    ...over,
  };
}

describe('a run’s summary', () => {
  it('counts, times from intake to the last decision, and groups holds by reason', () => {
    const rows = [
      ...[1_000, 2_000, 3_000, 4_000, 10_000].map((ms) =>
        row({ status: 'settled', decidedAt: at(ms - 500), finalizedAt: at(ms) }),
      ),
      row({ status: 'held', reason: 'address_mismatch', decidedAt: at(1_500) }),
      row({ status: 'held', reason: 'address_mismatch', decidedAt: at(1_600) }),
      row({ status: 'blocked', reason: 'duplicate_invoice', decidedAt: at(800) }),
    ];
    const s = runSummary({ id: 'run', account: ACCOUNT, size: 8, createdAt: T0 }, rows, at(60_000));
    expect(s).toMatchObject({
      size: 8,
      decided: 8,
      done: true,
      elapsedMs: 10_000,
      settled: { count: 5, p50Ms: 3_000, p95Ms: 10_000, maxMs: 10_000 },
      held: [{ reason: 'address_mismatch', count: 2 }],
      blocked: [{ reason: 'duplicate_invoice', count: 1 }],
    });
    expect(s.held[0]?.ids).toHaveLength(2);
  });

  it('runs its clock until every payment is decided', () => {
    const rows = [
      row({ status: 'settled', decidedAt: at(500), finalizedAt: at(1_000) }),
      row({ status: 'checking' }),
    ];
    const s = runSummary({ id: 'run', account: ACCOUNT, size: 2, createdAt: T0 }, rows, at(7_000));
    expect(s).toMatchObject({ decided: 1, done: false, elapsedMs: 7_000 });
  });
});

const submitRun = (token: string, account: Address, n: number) =>
  app.request('/v1/runs', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      account,
      payments: Array.from({ length: n }, (_, i) => ({
        vault: VAULT,
        payment: {
          amount: '1000',
          invoiceHash: keccak256(
            toHex(`run invoice ${account} ${String(i)} ${String(Math.random())}`),
          ),
          payTo: SUPPLIER,
          deadline: 1_791_400_000,
        },
        agentSig: AGENT_SIG,
      })),
    }),
  });

describe('runs over the API', () => {
  it('a run’s view has its summary', async () => {
    const { runId } = (await (await submitRun(TOKEN, ACCOUNT, 3)).json()) as { runId: string };
    const view = (await (
      await app.request(`/v1/runs/${runId}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { summary: { size: number; decided: number; done: boolean } };
    expect(view.summary).toMatchObject({ size: 3, decided: 0, done: false });
  });

  it('lists an account’s runs, newest first; an account token sees only its own', async () => {
    const first = (await (await submitRun(TOKEN, ACCOUNT, 2)).json()) as { runId: string };
    const second = (await (await submitRun(TOKEN, ACCOUNT, 1)).json()) as { runId: string };
    await submitRun(TOKEN, OTHER, 1);
    const res = await app.request(`/v1/accounts/${ACCOUNT}/runs`, {
      headers: { authorization: `Bearer ${MINE}` },
    });
    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as { runs: { runId: string; size: number }[] };
    expect(runs.map((r) => r.runId)).toEqual([second.runId, first.runId]);
    expect(
      (
        await app.request(`/v1/accounts/${OTHER}/runs`, {
          headers: { authorization: `Bearer ${MINE}` },
        })
      ).status,
    ).toBe(403);
  });
});

describe('the run page (public, read-only, until the approver app’s board)', () => {
  it('shows the counts and the holds by reason, each linked to its approval page', async () => {
    const { runId, requests } = (await (await submitRun(TOKEN, ACCOUNT, 3)).json()) as {
      runId: string;
      requests: { id: Hex }[];
    };
    const held = requests[0]?.id as Hex;
    await store.transition(held, 'requested', 'checking');
    await store.transition(held, 'checking', 'held', {
      reason: 'address_mismatch',
      decidedBy: 'rule',
    });
    const res = await app.request(`/r/${runId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('3 invoices');
    expect(html).toContain('payment address is not the supplier');
    expect(html).toContain(`/p/${held}`);
    expect(html).not.toContain(TOKEN);

    const json = (await (await app.request(`/r/${runId}?format=json`)).json()) as {
      held: { reason: string; count: number }[];
    };
    expect(json.held).toEqual([expect.objectContaining({ reason: 'address_mismatch', count: 1 })]);
    expect((await app.request(`/r/0x${'00'.repeat(32)}`)).status).toBe(404);
  });
});
