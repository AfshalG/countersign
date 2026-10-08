import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { hashToken } from '../src/api/account-tokens.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

/**
 * Account tokens (Slice 12 part 2): a developer's test account calls the API with its own token,
 * which reaches only that account. The service token is unchanged.
 */
let database: Database;
let store: Store;
let app: ReturnType<typeof createApp>;
const SERVICE = 'test-service-token-0123456789';
const MINE = `cs_${'a'.repeat(43)}`;
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
    token: SERVICE,
    health: () => Promise.resolve({}),
  });
  await store.issueApiToken(ACCOUNT, hashToken(MINE), 0);
  await store.registerAccount(ACCOUNT, 1, 'developer');
  await store.registerAccount(OTHER, 1, 'someone else');
});

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});
const call = (token: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const submission = (account: Address, invoice: string) => ({ account, ...item(invoice) });
/** One payment of a run (the run names the account once). */
const item = (invoice: string) => ({
  vault: VAULT,
  payment: {
    amount: '1000',
    invoiceHash: keccak256(toHex(invoice)),
    payTo: SUPPLIER,
    deadline: 1_791_400_000,
  },
  agentSig: AGENT_SIG,
});
const proposal = (account: Address, doc: string) => ({
  account,
  supplier: { name: 'Northwind Prints', payTo: SUPPLIER },
  order: { amount: '1000', expiry: 1_791_400_000 },
  documentHash: keccak256(toHex(doc)),
});

describe('an account token', () => {
  it('reaches its own account: pay, read the payment, orders, propose, read the proposal', async () => {
    const paid = await call(MINE, 'POST', '/v1/payments', submission(ACCOUNT, 'INV-mine'));
    expect(paid.status).toBe(201);
    const { request } = (await paid.json()) as { request: { id: string } };
    expect((await call(MINE, 'GET', `/v1/payments/${request.id}`)).status).toBe(200);
    expect((await call(MINE, 'GET', `/v1/accounts/${ACCOUNT}/orders`)).status).toBe(200);
    const proposed = await call(MINE, 'POST', '/v1/proposals', proposal(ACCOUNT, 'quote-mine'));
    expect(proposed.status).toBe(201);
    const { proposal: p } = (await proposed.json()) as { proposal: { id: string } };
    expect((await call(MINE, 'GET', `/v1/proposals/${p.id}`)).status).toBe(200);
    const run = await call(MINE, 'POST', '/v1/runs', {
      account: ACCOUNT,
      payments: [item('INV-run')],
    });
    expect(run.status).toBe(201);
    const { runId } = (await run.json()) as { runId: string };
    expect((await call(MINE, 'GET', `/v1/runs/${runId}`)).status).toBe(200);
  });

  it('is refused for another account (403), and another account’s records look unknown (404)', async () => {
    for (const [method, path, body] of [
      ['POST', '/v1/payments', submission(OTHER, 'INV-x')],
      ['POST', '/v1/checks', submission(OTHER, 'INV-x')],
      ['POST', '/v1/proposals', proposal(OTHER, 'quote-x')],
      ['POST', '/v1/accounts', { account: OTHER }],
      ['GET', `/v1/accounts/${OTHER}/orders`, undefined],
      [
        'POST',
        '/v1/runs',
        {
          account: OTHER,
          payments: [item('INV-y')],
        },
      ],
    ] as const) {
      const res = await call(MINE, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('wrong_account');
    }

    // Made with the service token, for the other account.
    const theirs = (await (
      await call(SERVICE, 'POST', '/v1/payments', submission(OTHER, 'INV-theirs'))
    ).json()) as { request: { id: string } };
    const theirProposal = (await (
      await call(SERVICE, 'POST', '/v1/proposals', proposal(OTHER, 'quote-theirs'))
    ).json()) as { proposal: { id: string } };
    const theirRun = (await (
      await call(SERVICE, 'POST', '/v1/runs', {
        account: OTHER,
        payments: [item('INV-r')],
      })
    ).json()) as { runId: string };
    expect((await call(MINE, 'GET', `/v1/payments/${theirs.request.id}`)).status).toBe(404);
    expect((await call(MINE, 'GET', `/v1/proposals/${theirProposal.proposal.id}`)).status).toBe(
      404,
    );
    expect((await call(MINE, 'GET', `/v1/runs/${theirRun.runId}`)).status).toBe(404);
    const refuse = await call(MINE, 'POST', `/v1/payments/${theirs.request.id}/refuse`, {
      ownerAuth: {
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
        challengeIndex: '23',
        typeIndex: '1',
        authenticatorData: `0x${'33'.repeat(37)}`,
        clientDataJSON: '{"type":"webauthn.get"}',
      },
      decision: { reasonHash: `0x${'00'.repeat(32)}`, evidenceHash: `0x${'00'.repeat(32)}` },
    });
    expect(refuse.status).toBe(404);
  });

  it('cannot call routes that are not one account’s (default deny)', async () => {
    const res = await call(MINE, 'GET', '/v1/agents');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not_for_account_tokens');
  });

  it('stops working once a new token replaces it; an unknown token is 401', async () => {
    await store.issueApiToken(ACCOUNT, hashToken(`cs_${'b'.repeat(43)}`), 1);
    expect((await call(MINE, 'GET', `/v1/accounts/${ACCOUNT}/orders`)).status).toBe(401);
    expect(
      (await call(`cs_${'c'.repeat(43)}`, 'GET', `/v1/accounts/${ACCOUNT}/orders`)).status,
    ).toBe(401);
  });

  it('sees only its own account on the feed', async () => {
    const res = await call(MINE, 'GET', '/v1/feed');
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (!reader) throw new Error('no stream');
    const theirs = (await (
      await call(SERVICE, 'POST', '/v1/payments', submission(OTHER, 'INV-feed-theirs'))
    ).json()) as { request: { id: string } };
    const mine = (await (
      await call(MINE, 'POST', '/v1/payments', submission(ACCOUNT, 'INV-feed-mine'))
    ).json()) as { request: { id: string } };
    let text = '';
    const deadline = Date.now() + 2_000;
    while (!text.includes(mine.request.id) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain(mine.request.id);
    expect(text).toContain(`"account":"${ACCOUNT}"`);
    expect(text).not.toContain(theirs.request.id);
  });
});

describe('the service token', () => {
  it('still reaches every account', async () => {
    expect((await call(SERVICE, 'GET', `/v1/accounts/${OTHER}/orders`)).status).toBe(200);
    expect((await call(SERVICE, 'POST', '/v1/payments', submission(OTHER, 'INV-s'))).status).toBe(
      201,
    );
  });
});
