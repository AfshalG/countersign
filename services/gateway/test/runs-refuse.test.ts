import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { groupRefusalChallenge } from '../src/api/approvals.js';
import { SoftPasskey } from '../scripts/passkey.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

/**
 * Slice 16, D18: a run's holds of one reason refused together with one passkey signature over
 * exactly the list the owner saw. No token: the passkey is the authorisation.
 */
let database: Database;
let store: Store;
let chain: FakeChain;
let app: ReturnType<typeof createApp>;
const TOKEN = 'test-service-token-0123456789';
const CHAIN_ID = 10143;
const owner = SoftPasskey.fromScalar(`0x${'31'.repeat(32)}`);
const stranger = SoftPasskey.fromScalar(`0x${'32'.repeat(32)}`);

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
  chain.ownerKeys = [{ qx: owner.qx, qy: owner.qy }];
  app = createApp({
    store,
    chain,
    checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
  });
});

/** A run of four: two held for a changed address, one for its amount, one paid. */
async function run() {
  const res = await app.request('/v1/runs', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      account: ACCOUNT,
      payments: [0, 1, 2, 3].map((i) => ({
        vault: VAULT,
        payment: {
          amount: '1000',
          invoiceHash: keccak256(toHex(`group ${String(i)} ${String(Math.random())}`)),
          payTo: SUPPLIER,
          deadline: 1_791_400_000,
        },
        agentSig: AGENT_SIG,
      })),
    }),
  });
  const { runId, requests } = (await res.json()) as { runId: string; requests: { id: Hex }[] };
  const reasons = ['address_mismatch', 'address_mismatch', 'amount_mismatch'] as const;
  for (const [i, reason] of reasons.entries()) {
    const id = requests[i]?.id as Hex;
    await store.transition(id, 'requested', 'checking');
    await store.transition(id, 'checking', 'held', { reason, decidedBy: 'rule' });
  }
  return { runId, ids: requests.map((r) => r.id) };
}

type Group = { ids: string[]; count: number; challenge: Hex | null; summary: string };
const group = async (runId: string, reason: string) =>
  (await (await app.request(`/v1/approvals/runs/${runId}?reason=${reason}`)).json()) as Group;
const refuse = (runId: string, reason: string, key: SoftPasskey, challenge: Hex) => {
  const a = key.sign(challenge);
  return app.request(`/v1/approvals/runs/${runId}?reason=${reason}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://approver.example' },
    body: JSON.stringify({
      assertion: {
        authenticatorData: a.authenticatorData,
        clientDataJSON: a.clientDataJSON,
        signature: { r: a.r, s: a.s },
      },
    }),
  });
};

describe('refusing a run’s holds of one reason, with one signature', () => {
  it('lists them and the challenge that covers exactly them', async () => {
    const { runId, ids } = await run();
    const g = await group(runId, 'address_mismatch');
    expect(g.count).toBe(2);
    expect([...g.ids].sort()).toEqual([ids[0], ids[1]].sort());
    expect(g.challenge).toBe(
      groupRefusalChallenge(CHAIN_ID, ACCOUNT, runId, 'address_mismatch', g.ids),
    );
    expect(g.summary).toContain('Refuse 2 held payments');
    const none = await group(runId, 'duplicate_invoice');
    expect(none).toMatchObject({ count: 0, challenge: null });
  });

  it('refuses them all with the owner’s passkey, and nothing else', async () => {
    const { runId, ids } = await run();
    const g = await group(runId, 'address_mismatch');
    const res = await refuse(runId, 'address_mismatch', owner, g.challenge as Hex);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refused: number }).refused).toBe(2);
    for (const id of [ids[0], ids[1]]) {
      const row = await store.get(id as string);
      expect(row).toMatchObject({ status: 'refused', decidedBy: 'user_refused' });
      // The group signature is kept as the owner's evidence on each.
      expect(JSON.stringify(row?.ownerAuth)).toContain('"group"');
    }
    expect((await store.get(ids[2] as string))?.status).toBe('held');
    expect((await store.get(ids[3] as string))?.status).toBe('requested');
  });

  it('refuses a passkey that is not an owner’s, and changes nothing', async () => {
    const { runId, ids } = await run();
    const g = await group(runId, 'address_mismatch');
    const res = await refuse(runId, 'address_mismatch', stranger, g.challenge as Hex);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_passkey');
    expect((await store.get(ids[0] as string))?.status).toBe('held');
  });

  it('a list that changed since it was shown is not refused: sign it again', async () => {
    const { runId, ids } = await run();
    const g = await group(runId, 'address_mismatch');
    // One of them is decided on its own meanwhile.
    await store.transition(ids[0] as string, 'held', 'refused', {
      reason: 'user_refused',
      decidedBy: 'user_refused',
    });
    const res = await refuse(runId, 'address_mismatch', owner, g.challenge as Hex);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('challenge_mismatch');
    expect((await store.get(ids[1] as string))?.status).toBe('held');
  });

  it('knows only real runs', async () => {
    expect(
      (await app.request(`/v1/approvals/runs/0x${'00'.repeat(32)}?reason=address_mismatch`)).status,
    ).toBe(404);
  });
});
