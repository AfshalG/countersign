import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { IDENTITY_REGISTRY_TESTNET, paymentTypes, vaultDomain } from '@countersign/shared';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { TestChecker } from '../src/checker.js';
import { AgentDirectory, recoverAgent, type IdentityChain } from '../src/agents/identity.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, FakeChain, SUPPLIER, VAULT } from './fakes.js';

let database: Database;
let store: Store;
let wallets: Map<bigint, Address>;
let directory: AgentDirectory;
const TOKEN = 'test-service-token-0123456789';
const CHAIN_ID = 10143;
const agent = privateKeyToAccount(generatePrivateKey());

const identity: IdentityChain = {
  agentWallet: (id) => {
    const w = wallets.get(id);
    return w ? Promise.resolve(w) : Promise.reject(new Error('ERC721NonexistentToken'));
  },
};

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  wallets = new Map([[2066n, agent.address]]);
  directory = new AgentDirectory(identity, IDENTITY_REGISTRY_TESTNET, CHAIN_ID);
});

const app = () =>
  createApp({
    store,
    chain: new FakeChain(),
    checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
    chainId: CHAIN_ID,
    checkerTimeoutMs: 2_000,
    token: TOKEN,
    publicUrl: 'https://gateway.test',
    health: () => Promise.resolve({}),
    agents: directory,
  });
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const payment = (n: string) => ({
  amount: 1_000n,
  invoiceHash: keccak256(toHex(n)),
  payTo: SUPPLIER,
  deadline: 1_791_400_000n,
});
const signed = async (n: string, signer = agent) =>
  signer.signTypedData({
    domain: vaultDomain(CHAIN_ID, VAULT),
    types: paymentTypes,
    primaryType: 'Payment',
    message: payment(n),
  });
const submit = async (a: ReturnType<typeof app>, n: string, signer = agent) => {
  const p = payment(n);
  const res = await a.request('/v1/payments', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      account: ACCOUNT,
      vault: VAULT,
      payment: { ...p, amount: p.amount.toString(), deadline: Number(p.deadline) },
      agentSig: await signed(n, signer),
    }),
  });
  return ((await res.json()) as { request: { id: string; agent: unknown } }).request;
};

describe('which agent signed a payment (ERC-8004)', () => {
  it('recovers the agent’s address from its signature, as the vault checks it', async () => {
    expect(await recoverAgent(CHAIN_ID, VAULT, payment('INV-1'), await signed('INV-1'))).toBe(
      agent.address,
    );
    expect(
      await recoverAgent(CHAIN_ID, VAULT, payment('INV-1'), `0x${'00'.repeat(65)}`),
    ).toBeNull();
  });

  it('shows the agent on every payment, with its ERC-8004 id once registered here', async () => {
    const a = app();
    expect((await submit(a, 'INV-2')).agent).toEqual({
      address: agent.address,
      agentId: null,
      registry: null,
    });
    const res = await a.request('/v1/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: '2066' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agentId: '2066', wallet: agent.address });
    const view = await submit(a, 'INV-3');
    expect(view.agent).toEqual({
      address: agent.address,
      agentId: '2066',
      registry: `eip155:10143:${IDENTITY_REGISTRY_TESTNET}`,
    });
    // An earlier payment by the same key shows the id too: it is looked up when shown.
    const earlier = (await (
      await a.request(`/v1/payments/${(await store.listByStatus('requested', 10))[0]?.id ?? ''}`, {
        headers: auth,
      })
    ).json()) as { agent: { agentId: string | null } };
    expect(earlier.agent.agentId).toBe('2066');
  });

  it('says on the status page which agent sent it, and only says "paid" once it is', async () => {
    const a = app();
    await a.request('/v1/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: '2066' }),
    });
    const view = await submit(a, 'INV-5');
    const html = await (await a.request(`/p/${view.id}`)).text();
    expect(html).toContain('Sent by agent');
    expect(html).not.toContain('Paid by agent');
    expect(html).toContain('#2066');
  });

  it('refuses an agent id that does not exist, and lists the agents it knows', async () => {
    const a = app();
    const missing = await a.request('/v1/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: '999999' }),
    });
    expect(missing.status).toBe(404);
    await a.request('/v1/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: '2066' }),
    });
    const list = (await (await a.request('/v1/agents', { headers: auth })).json()) as {
      agents: { agentId: string }[];
    };
    expect(list.agents.map((x) => x.agentId)).toEqual(['2066']);
  });

  it('stops naming an agent whose wallet moved on chain (checked when the gateway starts)', async () => {
    const a = app();
    await a.request('/v1/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: '2066' }),
    });
    wallets.set(2066n, '0x7777777777777777777777777777777777777777');
    const fresh = new AgentDirectory(identity, IDENTITY_REGISTRY_TESTNET, CHAIN_ID);
    await fresh.load(store);
    expect(fresh.byAddress(agent.address)).toBeUndefined();
  });
});
