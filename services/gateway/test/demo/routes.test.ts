import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { TestChecker } from '../../src/checker.js';
import type { DemoDeps } from '../../src/demo/accounts.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { FakeChain } from '../fakes.js';
import { CHAIN_ID, demoDeps, type FakeDemoChain } from './fakes.js';

let database: Database;
let store: Store;
let chain: FakeDemoChain;
let deps: DemoDeps;
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
  ({ deps, chain } = demoDeps(store));
});

const appWith = (demo: DemoDeps | undefined) =>
  createApp({
    store,
    chain: new FakeChain(),
    checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
    ...(demo ? { demo } : {}),
  });

const judge = SoftPasskey.fromScalar(`0x${'77'.repeat(32)}`);
type View = {
  account: Address;
  status: string;
  actions: { action: string; challenge: Hex }[];
  order: { amountUsdc: string } | null;
};
const post = (app: ReturnType<typeof appWith>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://approver.example' },
    body: JSON.stringify(body),
  });
const assertion = (digest: Hex) => {
  const a = judge.sign(digest);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};

describe('judge mode over HTTP (what the approver app calls, with no token)', () => {
  it('creates the account for a passkey and gives back the three actions to sign', async () => {
    const app = appWith(deps);
    const res = await post(app, '/v1/demo/accounts', { publicKey: { x: judge.qx, y: judge.qy } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const view = (await res.json()) as View;
    expect(view.status).toBe('awaiting_passkey');
    expect(view.actions.map((a) => a.action)).toEqual(['setPolicy', 'setSupplier', 'approveOrder']);
    // The browser's own format gives the same account.
    const spki = judge.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const again = (await (
      await post(app, '/v1/demo/accounts', { publicKey: { spki } })
    ).json()) as View;
    expect(again.account).toBe(view.account);
    const read = await app.request(`/v1/demo/accounts/${view.account}`);
    expect(((await read.json()) as View).account).toBe(view.account);
  });

  it('sets the account up with the three assertions, then shows its order', async () => {
    const app = appWith(deps);
    const view = (await (
      await post(app, '/v1/demo/accounts', { publicKey: { x: judge.qx, y: judge.qy } })
    ).json()) as View;
    const res = await post(app, `/v1/demo/accounts/${view.account}/setup`, {
      assertions: view.actions.map((a) => assertion(a.challenge)),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ready', order: { amountUsdc: '0.005' } });
  });

  it('answers each refusal with its status and code', async () => {
    const app = appWith(deps);
    const view = (await (
      await post(app, '/v1/demo/accounts', { publicKey: { x: judge.qx, y: judge.qy } })
    ).json()) as View;
    const [a0, a1, a2] = view.actions.map((a) => assertion(a.challenge));
    const swapped = await post(app, `/v1/demo/accounts/${view.account}/setup`, {
      assertions: [a1, a0, a2],
    });
    expect(swapped.status).toBe(422);
    expect(await swapped.json()).toMatchObject({ error: 'challenge_mismatch' });
    expect((await app.request(`/v1/demo/accounts/0x${'00'.repeat(20)}`)).status).toBe(404);
    expect((await post(app, '/v1/demo/accounts', { publicKey: { x: 'nope' } })).status).toBe(400);
    chain.invalidKey = true;
    const other = SoftPasskey.fromScalar(`0x${'88'.repeat(32)}`);
    const bad = await post(app, '/v1/demo/accounts', { publicKey: { x: other.qx, y: other.qy } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_public_key' });
    chain.invalidKey = false;
    deps.perDay = 1;
    const limited = await post(app, '/v1/demo/accounts', {
      publicKey: { x: other.qx, y: other.qy },
    });
    expect(limited.status).toBe(429);
  });

  it('answers the browser’s CORS preflight', async () => {
    const res = await appWith(deps).request('/v1/demo/accounts', {
      method: 'OPTIONS',
      headers: { origin: 'https://approver.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
  });

  it('has no judge-mode routes when judge mode is off', async () => {
    const app = appWith(undefined);
    const res = await post(app, '/v1/demo/accounts', { publicKey: { x: judge.qx, y: judge.qy } });
    expect(res.status).toBe(404);
    const spec = (await (await app.request('/openapi.json')).json()) as { paths: object };
    expect(Object.keys(spec.paths)).not.toContain('/v1/demo/accounts');
    const on = (await (await appWith(deps).request('/openapi.json')).json()) as { paths: object };
    expect(Object.keys(on.paths)).toContain('/v1/demo/accounts/{account}/setup');
  });
});
