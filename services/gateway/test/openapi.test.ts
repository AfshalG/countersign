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
        '/v1/accounts',
        '/v1/accounts/{account}/orders',
        '/v1/proposals',
        '/v1/proposals/{id}',
        '/v1/runs',
        '/v1/runs/{id}',
      ].sort(),
    );
    expect(doc.components.securitySchemes.Bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    for (const [path, ops] of Object.entries(doc.paths))
      for (const op of Object.values(ops))
        if (path.startsWith('/v1')) expect(op.security, path).toEqual([{ Bearer: [] }]);
  });

  it('renders the reference page', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('Countersign gateway API');
  });
});
