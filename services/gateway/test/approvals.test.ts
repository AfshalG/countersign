import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashTypedData, keccak256, stringToHex, toHex, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { decisionTypes, OUTCOME, paymentTypes, vaultDomain } from '@countersign/shared';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { checkOne } from '../src/pipeline/check.js';
import { SoftPasskey } from '../scripts/passkey.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

let database: Database;
let store: Store;
let chain: FakeChain;
let app: ReturnType<typeof createApp>;
const TOKEN = 'test-service-token-0123456789';
const CHAIN_ID = 10143;
const ON_FILE = '0x90f9931B748B26763161a8191C178Fe425C25fEd';
const owner = SoftPasskey.fromScalar(`0x${'33'.repeat(32)}`);
const checker = new TestChecker(generatePrivateKey(), CHAIN_ID);

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
    checker,
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
  });
});

const deadline = 1_791_400_000;

/** A payment held for an address not on file, as the gateway would hold it. */
async function held(invoice: string) {
  chain.rule = (_p, call) =>
    call.kind === 'pay' && call.checkerSig === '0x' ? 'PayToNotOnFile' : undefined;
  chain.onFile = ON_FILE;
  const res = await app.request('/v1/payments', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      account: ACCOUNT,
      vault: VAULT,
      payment: {
        amount: '1000',
        invoiceHash: keccak256(toHex(invoice)),
        payTo: SUPPLIER,
        deadline,
      },
      agentSig: AGENT_SIG,
    }),
  });
  const { request } = (await res.json()) as { request: { id: Hex } };
  const row = await store.get(request.id);
  if (!row) throw new Error('no row');
  await checkOne({ store, chain, checker, chainId: CHAIN_ID, checkerTimeoutMs: 2_000 }, row);
  chain.rule = undefined;
  return request.id;
}

type Action = {
  challenge: Hex;
  typedData: { primaryType: string; message: Record<string, unknown> };
};
type View = {
  kind: string;
  status: string;
  summary: Record<string, unknown>;
  differences: { field: string; onFile: string; onInvoice: string }[];
  actions: Record<string, Action>;
};
const view = async (id: string) =>
  (await (await app.request(`/v1/approvals/${id}`)).json()) as View;
const submit = (id: string, body: unknown) =>
  app.request(`/v1/approvals/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://approver.example' },
    body: JSON.stringify(body),
  });
const browser = (digest: Hex) => {
  const a = owner.sign(digest);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};

describe('GET /v1/approvals/{id} (what the phone shows and signs)', () => {
  it('shows a held payment: the reason, the two addresses, and the exact digest for each action', async () => {
    const id = await held('INV-0045');
    const res = await app.request(`/v1/approvals/${id}`, {
      headers: { origin: 'https://approver.example' },
    });
    expect(res.status).toBe(200); // no service token: the passkey is the authorisation
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const v = (await res.json()) as View;
    expect(v).toMatchObject({
      kind: 'payment',
      status: 'held',
      summary: { amountUsdc: '0.001', reason: 'address_mismatch', addressOnFile: ON_FILE },
      differences: [{ field: 'payTo', onFile: ON_FILE, onInvoice: SUPPLIER }],
    });
    expect(String(v.summary.reasonText)).toContain('not the supplier');
    const payment = {
      amount: 1000n,
      invoiceHash: keccak256(toHex('INV-0045')),
      payTo: SUPPLIER,
      deadline: BigInt(deadline),
    };
    expect(v.actions.pay_once?.challenge).toBe(
      hashTypedData({
        domain: vaultDomain(CHAIN_ID, VAULT),
        types: paymentTypes,
        primaryType: 'Payment',
        message: payment,
      }),
    );
    expect(v.actions.refuse?.challenge).toBe(
      hashTypedData({
        domain: vaultDomain(CHAIN_ID, VAULT),
        types: decisionTypes,
        primaryType: 'Decision',
        message: {
          invoiceHash: payment.invoiceHash,
          outcome: OUTCOME.refused,
          reasonHash: keccak256(stringToHex('refused by the owner')),
          evidenceHash: id,
        },
      }),
    );
    expect(v.actions.pay_once?.typedData.message).toMatchObject({
      amount: '1000',
      payTo: SUPPLIER,
    });
  });

  it('offers no actions once it is decided, and says so for an unknown id', async () => {
    const id = await held('INV-0046');
    await submit(id, {
      action: 'pay_once',
      assertion: browser((await view(id)).actions.pay_once?.challenge as Hex),
    });
    expect((await view(id)).actions).toEqual({});
    expect((await app.request(`/v1/approvals/0x${'00'.repeat(32)}`)).status).toBe(404);
  });
});

describe('POST /v1/approvals/{id} (the owner decides with the passkey)', () => {
  it('pays a held payment once with the owner’s passkey', async () => {
    const id = await held('INV-0047');
    const res = await submit(id, {
      action: 'pay_once',
      assertion: browser((await view(id)).actions.pay_once?.challenge as Hex),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await res.json()) as View).status).toBe('released');
    const row = await store.get(id);
    expect(row?.decidedBy).toBe('user_once');
    expect(JSON.stringify(row?.ownerAuth)).toContain('webauthn.get');
  });

  it('refuses a held payment, which nothing then pays', async () => {
    const id = await held('INV-0048');
    const res = await submit(id, {
      action: 'refuse',
      assertion: browser((await view(id)).actions.refuse?.challenge as Hex),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as View).status).toBe('refused');
    expect((await store.get(id))?.reason).toBe('user_refused');
  });

  it('refuses a passkey that signed another action, before anything reaches the chain', async () => {
    const id = await held('INV-0049');
    const simulations = chain.simulations;
    const res = await submit(id, {
      action: 'pay_once',
      assertion: browser((await view(id)).actions.refuse?.challenge as Hex),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'challenge_mismatch' });
    expect(chain.simulations).toBe(simulations);
    expect((await store.get(id))?.status).toBe('held');
  });

  it('refuses a passkey that is not the owner’s, and a decision on what is no longer held', async () => {
    const id = await held('INV-0050');
    chain.ownerKeyValid = false;
    const wrong = await submit(id, {
      action: 'pay_once',
      assertion: browser((await view(id)).actions.pay_once?.challenge as Hex),
    });
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_passkey' });
    chain.ownerKeyValid = true;
    const challenge = (await view(id)).actions.pay_once?.challenge as Hex;
    expect((await submit(id, { action: 'pay_once', assertion: browser(challenge) })).status).toBe(
      200,
    );
    const again = await submit(id, { action: 'pay_once', assertion: browser(challenge) });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'not_held' });
  });

  it('answers the browser’s CORS preflight', async () => {
    const res = await app.request(`/v1/approvals/0x${'11'.repeat(32)}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://approver.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
});
