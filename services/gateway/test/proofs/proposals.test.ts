import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, toHex, zeroHash, type Address, type Hex } from 'viem';
import { countersignAccountAbi } from '@countersign/chain';
import { supplierId } from '@countersign/shared';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { proposalId } from '../../src/api/orders.js';
import {
  approveProposal,
  proposalApprovalView,
  type ProposalDeps,
} from '../../src/owner/proposals.js';
import { OwnerActionError } from '../../src/owner/send.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { demoDeps, type FakeDemoChain } from '../demo/fakes.js';

/**
 * Slice 15 on the approval page: the website check is shown, the approval waits for it, and the
 * supplier record the owner signs names the proof only when the site lists the proposed address.
 */
let database: Database;
let store: Store;
let chain: FakeDemoChain;
let sent: { to: Address; data: Hex; gas: bigint }[];
let deps: ProposalDeps;
const ACCOUNT: Address = '0x4444444444444444444444444444444444444444';
const NORTHWIND: Address = '0x5555555555555555555555555555555555555555';
const OTHER: Address = '0x6666666666666666666666666666666666666666';
const FILE = 'https://northwind.example/.well-known/countersign.json';
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
  ({ chain, sent } = fake);
  deps = { ...fake.deps, store, chain };
  chain.ownerKeys.set(ACCOUNT.toLowerCase(), { qx: owner.qx, qy: owner.qy });
  chain.usdc.set(ACCOUNT.toLowerCase(), 50_000n);
});

async function proposed() {
  const documentHash = keccak256(toHex(`quote ${String(Math.random())}`));
  const { proposal } = await store.createProposal({
    id: proposalId(ACCOUNT, documentHash),
    account: ACCOUNT,
    supplierName: 'Northwind Prints',
    website: 'https://northwind.example',
    payTo: NORTHWIND,
    amount: '20000',
    expiry: Math.floor(Date.now() / 1000) + 30 * 86_400,
    documentHash,
    document: null,
  });
  return proposal;
}

/** A proposal whose check found the site listing `listed`, `hoursAgo` hours ago. */
async function checked(listed: Address, hoursAgo = 0) {
  const p = await proposed();
  await store.startProposalCheck(p.id, { url: FILE, source: 'proposal' });
  const proof = await store.addWebsiteProof({
    url: FILE,
    listed,
    signedAt: new Date(Date.now() - hoursAgo * 3_600_000),
    proofHash: keccak256(toHex(`proof of ${listed} ${String(hoursAgo)}`)),
    txHash: `0x${'cd'.repeat(32)}`,
    createdAt: new Date(),
  });
  await store.finishProposalCheck(p.id, { proofId: proof.id });
  const after = await store.getProposal(p.id);
  if (!after) throw new Error('no proposal');
  return { p: after, proof };
}

type View = Awaited<ReturnType<typeof proposalApprovalView>>;
const signApproval = (view: View) =>
  Object.fromEntries(
    Object.entries(view.actions)
      .filter(([k]) => k !== 'refuse')
      .map(([k, a]) => {
        const s = owner.sign(a.challenge);
        return [
          k,
          {
            authenticatorData: s.authenticatorData,
            clientDataJSON: s.clientDataJSON,
            signature: { r: s.r, s: s.s },
          },
        ];
      }),
  );
const proofHashSigned = (view: View) =>
  (view.actions.set_supplier?.typedData as { message: { proofHash: string } } | undefined)?.message
    .proofHash;

describe('the website check on a proposal', () => {
  it('verified: shown, and the supplier record the owner signs names the proof', async () => {
    const { p, proof } = await checked(NORTHWIND);
    const view = await proposalApprovalView(deps, p);
    expect(view.summary.websiteProof).toMatchObject({
      status: 'verified',
      site: 'northwind.example',
      source: 'proposal',
      listed: NORTHWIND,
      proofHash: proof.proofHash,
    });
    expect(view.summary.websiteProof?.text).toContain('northwind.example lists this address');
    expect(proofHashSigned(view)).toBe(proof.proofHash);

    await approveProposal(deps, p.id, signApproval(view));
    const setSupplier = sent
      .map((t) => decodeFunctionData({ abi: countersignAccountAbi, data: t.data }))
      .find((c) => c.functionName === 'setSupplier');
    expect(setSupplier?.args[3]).toBe(proof.proofHash);
    // A later address change for Northwind is checked at this site.
    expect(await store.supplierWebsite(ACCOUNT, supplierId('northwind-prints'))).toBe(FILE);
  });

  it('not listed: shown with the address the site lists, and nothing is bound', async () => {
    const { p } = await checked(OTHER);
    const view = await proposalApprovalView(deps, p);
    expect(view.summary.websiteProof).toMatchObject({ status: 'not_listed', listed: OTHER });
    expect(view.summary.websiteProof?.text).toContain(`lists a different address: ${OTHER}`);
    expect(proofHashSigned(view)).toBe(zeroHash);
  });

  it('older than a day: stale, never verified (D21), though it still names what it proved', async () => {
    const { p, proof } = await checked(NORTHWIND, 30);
    const view = await proposalApprovalView(deps, p);
    expect(view.summary.websiteProof?.status).toBe('stale');
    expect(proofHashSigned(view)).toBe(proof.proofHash);
  });

  it('while it runs, only refuse is offered and approving waits', async () => {
    const p = await proposed();
    await store.startProposalCheck(p.id, { url: FILE, source: 'proposal' });
    const running = await store.getProposal(p.id);
    if (!running) throw new Error('no proposal');
    const view = await proposalApprovalView(deps, running);
    expect(view.summary.websiteProof?.status).toBe('checking');
    expect(Object.keys(view.actions)).toEqual(['refuse']);
    await expect(approveProposal(deps, p.id, {})).rejects.toMatchObject({
      status: 409,
      code: 'website_checking',
    } satisfies Partial<OwnerActionError>);
  });

  it('could not be checked: says so, and the owner can still approve with nothing bound', async () => {
    const p = await proposed();
    await store.finishProposalCheck(p.id, { error: 'no_website', url: null });
    const after = await store.getProposal(p.id);
    if (!after) throw new Error('no proposal');
    const view = await proposalApprovalView(deps, after);
    expect(view.summary.websiteProof).toMatchObject({
      status: 'unavailable',
      reason: 'no_website',
    });
    expect(view.summary.websiteProof?.text).toContain('confirm the address with the supplier');
    expect(proofHashSigned(view)).toBe(zeroHash);
  });

  it('a proposal from before Slice 15 shows no check at all', async () => {
    const view = await proposalApprovalView(deps, await proposed());
    expect(view.summary.websiteProof).toBeNull();
    expect(proofHashSigned(view)).toBe(zeroHash);
  });
});

describe('a proposal made while the gateway checks websites (Slice 15, found in Slice 16)', () => {
  it('waits from the first instant: stored as checking, so approval is never offered before the check', async () => {
    const { createApp } = await import('../../src/app.js');
    const { TestChecker } = await import('../../src/checker.js');
    const { FakeChain } = await import('../fakes.js');
    const { generatePrivateKey } = await import('viem/accounts');
    const TOKEN = 'test-service-token-0123456789';
    const app = createApp({
      store,
      chain: new FakeChain(),
      checker: new TestChecker(generatePrivateKey(), 10143),
      chainId: 10143,
      checkerTimeoutMs: 2_000,
      token: TOKEN,
      health: () => Promise.resolve({}),
      // A website check that has not started yet (it runs after the proposal is stored).
      websites: {
        siteOnFile: () => Promise.resolve(null),
        check: () => new Promise(() => undefined),
        websiteChanged: () => Promise.resolve(null),
      },
    });
    const res = await app.request('/v1/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        account: ACCOUNT,
        supplier: {
          name: 'Northwind Prints',
          website: 'https://northwind.example',
          payTo: NORTHWIND,
        },
        order: { amount: '20000', expiry: Math.floor(Date.now() / 1000) + 86_400 },
        documentHash: keccak256(toHex('a quote just read')),
      }),
    });
    const { proposal } = (await res.json()) as { proposal: { id: string } };
    const stored = await store.getProposal(proposal.id);
    expect(stored?.proofStatus).toBe('checking');
    if (!stored) throw new Error('no proposal');
    const view = await proposalApprovalView(deps, stored);
    expect(Object.keys(view.actions)).toEqual(['refuse']);
  });
});
