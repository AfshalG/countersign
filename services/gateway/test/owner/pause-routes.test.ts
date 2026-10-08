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
  fake.chain.ownerKeys.set(ACCOUNT.toLowerCase(), { qx: owner.qx, qy: owner.qy });
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

describe('changing the owners over HTTP (D36)', () => {
  const second = SoftPasskey.fromScalar(`0x${'88'.repeat(32)}`);
  const post = (a: ReturnType<typeof app>, path: string, body: unknown) =>
    a.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://approver.example' },
      body: JSON.stringify(body),
    });

  it('previews adding a second owner, signs it, and shows the new owners', async () => {
    const a = app();
    const change = {
      owners: [
        { x: owner.qx, y: owner.qy },
        { x: second.qx, y: second.qy },
      ],
      manage: 2,
      release: 1,
    };
    const pv = await post(a, `/v1/owner/${ACCOUNT}/owners/preview`, change);
    expect(pv.status).toBe(200);
    const { challenge, deadline } = (await pv.json()) as { challenge: Hex; deadline: number };
    const done = await post(a, `/v1/owner/${ACCOUNT}/owners`, {
      ...change,
      deadline,
      assertion: browser(challenge),
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ manage: 2, release: 1, ownerChanges: [] });
  });

  it('refuses a set that could never work, before anything is signed', async () => {
    const res = await post(app(), `/v1/owner/${ACCOUNT}/owners/preview`, {
      owners: [{ x: owner.qx, y: owner.qy }],
      manage: 2,
      release: 1,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_owners' });
  });
});
