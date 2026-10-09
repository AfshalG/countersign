import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validate } from '@scalar/openapi-parser';
import { generatePrivateKey } from 'viem/accounts';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { freshDatabase } from './db/helpers.js';
import { FakeChain } from './fakes.js';

let database: Database;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  database = await freshDatabase();
  app = createApp({
    store: new Store(database.db),
    chain: new FakeChain(),
    checker: new TestChecker(generatePrivateKey(), 10143),
    chainId: 10143,
    checkerTimeoutMs: 2_000,
    token: 'a-service-token-of-24-characters',
    health: () => Promise.resolve({}),
  });
});
afterAll(async () => {
  await database.pool.end();
});

describe('the API reference', () => {
  it('serves a valid OpenAPI 3.1 document without a token', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.openapi).toBe('3.1.0');
    const result = await validate(doc);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('documents every route, with the bearer token on /v1', async () => {
    const doc = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/health',
        '/v1/feed',
        '/v1/payments',
        '/v1/payments/{id}',
        '/v1/payments/{id}/approve',
        '/v1/payments/{id}/refuse',
        '/v1/checks',
        '/v1/advice',
        '/v1/advice/{id}',
        '/v1/payments/{id}/record',
        '/v1/accounts/{account}/records.csv',
        '/v1/accounts/{account}/inbox',
        '/v1/accounts',
        '/v1/accounts/{account}/banks',
        '/v1/owner/{account}/banks',
        '/v1/owner/{account}/banks/preview',
        '/v1/accounts/{account}/orders',
        '/v1/accounts/{account}/runs',
        '/v1/proposals',
        '/v1/proposals/{id}',
        '/v1/approvals/{id}',
        '/v1/approvals/runs/{runId}',
        '/v1/runs',
        '/v1/runs/{id}',
      ].sort(),
    );
    expect(doc.components.securitySchemes.Bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    for (const [path, ops] of Object.entries(doc.paths))
      for (const op of Object.values(ops))
        // The approvals and owner routes are the exception: the owner's passkey authorises them.
        if (path.startsWith('/v1') && !/^\/v1\/(approvals|owner)\//.test(path))
          expect(op.security, path).toEqual([{ Bearer: [] }]);
  });

  it('sends the bare address to the reference instead of a 404', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/docs');
  });

  it('serves llms.txt for coding agents: what it is, how to install, where the docs are', async () => {
    const res = await app.request('/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/markdown/);
    const text = await res.text();
    expect(text).toMatch(/^# Countersign\n\n> /);
    expect(text).toContain(
      'npm i https://github.com/AfshalG/countersign/releases/download/sdk-v0.3.0/countersign-sdk-0.3.0.tgz',
    );
    expect(text).toContain('/openapi.json');
    expect(text).toContain('https://countersign-mcp.vercel.app/api/mcp');
    expect(text).toContain('/llms-full.txt');
  });

  it('serves llms-full.txt with the quickstart and the SDK guide in one file', async () => {
    const res = await app.request('/llms-full.txt');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('# Developer quickstart');
    expect(text).toContain('# @countersign/sdk');
    expect(text).toContain('proposeOrder');
  });

  it('renders the reference page', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('Countersign gateway API');
  });
});
