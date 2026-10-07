import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { TestChecker } from '../../src/checker.js';
import type { PauseDeps } from '../../src/owner/pause.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { FakeChain } from '../fakes.js';
import { CHAIN_ID, demoDeps } from '../demo/fakes.js';

let database: Database;
let store: Store;
let pause: PauseDeps;
const ACCOUNT: Address = '0x4444444444444444444444444444444444444444';
const owner = SoftPasskey.fromScalar(`0x${'99'.repeat(32)}`);

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  const fake = demoDeps(store);
  pause = { ...fake.deps, store, chain: fake.chain };
});

const app = () =>
  createApp({
    store,
    chain: new FakeChain(),
    checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: 'test-service-token-0123456789',
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
    pause,
  });
type View = { paused: boolean; actions: Record<string, { challenge: Hex; deadline: number }> };
const browser = (digest: Hex) => {
  const a = owner.sign(digest);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};

describe('the stop button over HTTP (no token: the passkey decides)', () => {
  it('pauses and unpauses from the phone’s browser', async () => {
    const a = app();
    const res = await a.request(`/v1/owner/${ACCOUNT}`, {
      headers: { origin: 'https://approver.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const view = (await res.json()) as View;
    const p = view.actions.pause;
    const paused = await a.request(`/v1/owner/${ACCOUNT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'pause',
        deadline: p?.deadline,
        assertion: browser(p?.challenge as Hex),
      }),
    });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as View).paused).toBe(true);
    const again = await a.request(`/v1/owner/${ACCOUNT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'pause',
        deadline: p?.deadline,
        assertion: browser(p?.challenge as Hex),
      }),
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'already_paused' });
  });
});
