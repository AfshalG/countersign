import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { countersignAccountAbi, ownerGas } from '@countersign/chain';
import { accountDomain, ownerActionTypes, supplierId } from '@countersign/shared';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { proposalId } from '../../src/api/orders.js';
import {
  approveProposal,
  proposalApprovalView,
  refuseChallenge,
  refuseProposal,
  type ProposalDeps,
} from '../../src/owner/proposals.js';
import { OwnerActionError } from '../../src/owner/send.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { CHAIN_ID, demoDeps, type FakeDemoChain } from '../demo/fakes.js';

let database: Database;
let store: Store;
let chain: FakeDemoChain;
let sent: { to: Address; data: Hex; gas: bigint }[];
let deps: ProposalDeps;
const ACCOUNT: Address = '0x4444444444444444444444444444444444444444';
const NORTHWIND: Address = '0x5555555555555555555555555555555555555555';
const owner = SoftPasskey.fromScalar(`0x${'99'.repeat(32)}`);
const stranger = SoftPasskey.fromScalar(`0x${'aa'.repeat(32)}`);

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
  chain.nonces.set(ACCOUNT.toLowerCase(), 4n); // four owner actions already done
});

/** What an agent proposes after reading a quote (Slice 12's POST /v1/proposals). */
async function proposed(name = 'Northwind Prints', payTo = NORTHWIND, amount = '20000') {
  const documentHash = keccak256(toHex(`quote from ${name} ${payTo} ${amount}`));
  const { proposal } = await store.createProposal({
    id: proposalId(ACCOUNT, documentHash),
    account: ACCOUNT,
    supplierName: name,
    website: 'https://northwind.example',
    payTo,
    amount,
    expiry: Math.floor(Date.now() / 1000) + 30 * 86_400,
    documentHash,
    document: null,
  });
  return proposal;
}
type View = Awaited<ReturnType<typeof proposalApprovalView>>;
const browser = (passkey: SoftPasskey, digest: string) => {
  const a = passkey.sign(digest as Hex);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};
const signApproval = (view: View, passkey = owner) =>
  Object.fromEntries(
    Object.entries(view.actions)
      .filter(([k]) => k !== 'refuse')
      .map(([k, a]) => [k, browser(passkey, a.challenge)]),
  );
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof OwnerActionError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error('expected a refusal');
};
const functionsSent = () =>
  sent.map((t) => decodeFunctionData({ abi: countersignAccountAbi, data: t.data }).functionName);

describe('a proposed supplier and order, approved with the owner’s passkey', () => {
  it('offers two signatures for a new supplier (add it, then open the order) at the next owner nonces', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    expect(Object.keys(view.actions).sort()).toEqual(['approve_order', 'refuse', 'set_supplier']);
    const id = supplierId('northwind-prints');
    const deadline = BigInt(Math.floor(p.createdAt.getTime() / 1000) + 7 * 86_400);
    expect(view.actions.set_supplier?.challenge).toBe(
      hashTypedData({
        domain: accountDomain(CHAIN_ID, ACCOUNT),
        types: ownerActionTypes,
        primaryType: 'SetSupplier',
        message: {
          supplierId: id,
          payTo: NORTHWIND,
          active: true,
          proofHash: `0x${'00'.repeat(32)}`,
          nonce: 4n,
          deadline,
        },
      }),
    );
    expect(view.actions.approve_order?.challenge).toBe(
      hashTypedData({
        domain: accountDomain(CHAIN_ID, ACCOUNT),
        types: ownerActionTypes,
        primaryType: 'ApproveOrder',
        message: {
          orderId: keccak256(p.id as Hex),
          supplierId: id,
          orderHash: p.documentHash as Hex,
          amount: 20_000n,
          expiry: BigInt(p.expiry),
          nonce: 5n,
          deadline,
        },
      }),
    );
    expect(view.summary).toMatchObject({
      supplierId: id,
      addressOnFile: null,
      enoughFunds: true,
      accountUsdc: '0.05',
    });
  });

  it('approves: adds the supplier, then opens the order, each final before the next', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    const done = await approveProposal(deps, p.id, signApproval(view));
    expect(functionsSent()).toEqual(['setSupplier', 'approveOrder']);
    expect(done.status).toBe('approved');
    expect((await store.getProposal(p.id))?.status).toBe('approved');
  });

  it('needs one signature when the supplier is already on file at the same address', async () => {
    chain.suppliers.set(`${ACCOUNT.toLowerCase()}:${supplierId('northwind-prints')}`, {
      payTo: NORTHWIND,
      active: true,
      activeAfter: 0,
    });
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    expect(Object.keys(view.actions).sort()).toEqual(['approve_order', 'refuse']);
    await approveProposal(deps, p.id, signApproval(view));
    expect(functionsSent()).toEqual(['approveOrder']);
  });

  it('shows a changed address as a difference: approving changes it for every order', async () => {
    chain.suppliers.set(`${ACCOUNT.toLowerCase()}:${supplierId('northwind-prints')}`, {
      payTo: '0x6666666666666666666666666666666666666666',
      active: true,
      activeAfter: 0,
    });
    chain.waitingPeriod = 172_800;
    const view = await proposalApprovalView(deps, await proposed());
    expect(view.differences).toEqual([
      {
        field: 'payTo',
        onFile: '0x6666666666666666666666666666666666666666',
        onInvoice: NORTHWIND,
      },
    ]);
    expect(view.summary).toMatchObject({ changesAddress: true, waitingPeriodSeconds: 172_800 });
  });

  it('offers only refuse when the account cannot fund the order, and says how much is missing', async () => {
    chain.usdc.set(ACCOUNT.toLowerCase(), 5_000n);
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    expect(Object.keys(view.actions)).toEqual(['refuse']);
    expect(view.summary).toMatchObject({ enoughFunds: false, accountUsdc: '0.005' });
    expect(await refusal(approveProposal(deps, p.id, {}))).toMatchObject({
      status: 409,
      code: 'insufficient_funds',
    });
  });

  it('refuses assertions for the wrong action, and a passkey that is not the owner’s, before anything is sent', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    const signed = signApproval(view);
    expect(
      await refusal(
        approveProposal(deps, p.id, {
          set_supplier: signed.approve_order,
          approve_order: signed.set_supplier,
        }),
      ),
    ).toMatchObject({ status: 422, code: 'challenge_mismatch' });
    chain.ownerKeyValid = false;
    expect(await refusal(approveProposal(deps, p.id, signApproval(view, stranger)))).toMatchObject({
      status: 422,
      code: 'invalid_passkey',
    });
    expect(sent).toHaveLength(0);
    expect((await store.getProposal(p.id))?.status).toBe('pending');
  });

  it('resumes after a crash: the supplier landed, only the order is sent', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    const signed = signApproval(view);
    chain.suppliers.set(`${ACCOUNT.toLowerCase()}:${supplierId('northwind-prints')}`, {
      payTo: NORTHWIND,
      active: true,
      activeAfter: 0,
    });
    chain.nonces.set(ACCOUNT.toLowerCase(), 5n);
    await approveProposal(deps, p.id, signed);
    expect(functionsSent()).toEqual(['approveOrder']);
  });
});

describe('refusing a proposal with the owner’s passkey', () => {
  it('signs a fixed challenge for this proposal, account and chain', async () => {
    const p = await proposed();
    expect(refuseChallenge(CHAIN_ID, p.account as Address, p.id as Hex)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: 'string' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
          ['Countersign: refuse proposal', p.id as Hex, ACCOUNT, BigInt(CHAIN_ID)],
        ),
      ),
    );
  });

  it('refuses it with the owner’s passkey, checked against the account’s key on chain', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    const done = await refuseProposal(
      deps,
      p.id,
      browser(owner, view.actions.refuse?.challenge ?? ''),
    );
    expect(done.status).toBe('refused');
    expect(sent).toHaveLength(0);
  });

  it('will not let anyone else refuse it', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    expect(
      await refusal(
        refuseProposal(deps, p.id, browser(stranger, view.actions.refuse?.challenge ?? '')),
      ),
    ).toMatchObject({ status: 422, code: 'invalid_passkey' });
    expect((await store.getProposal(p.id))?.status).toBe('pending');
  });

  it('offers nothing once decided', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    await refuseProposal(deps, p.id, browser(owner, view.actions.refuse?.challenge ?? ''));
    const after = await proposalApprovalView(deps, (await store.getProposal(p.id)) ?? p);
    expect(after.actions).toEqual({});
    expect(await refusal(approveProposal(deps, p.id, signApproval(view)))).toMatchObject({
      status: 409,
      code: 'not_pending',
    });
  });
});

describe('several approvers (D36): approving a proposal needs the manage threshold', () => {
  const second = SoftPasskey.fromScalar(`0x${'88'.repeat(32)}`);
  const signersOf = (data: Hex) => {
    const { args } = decodeFunctionData({ abi: countersignAccountAbi, data });
    return (args.at(-1) as readonly { owner: number }[]).map((s) => s.owner);
  };

  beforeEach(() => {
    chain.extraOwners.set(ACCOUNT.toLowerCase(), [{ qx: second.qx, qy: second.qy }]);
    chain.thresholds.set(ACCOUNT.toLowerCase(), { manage: 2, release: 1 });
  });

  it('sends nothing until a second owner signs, then each step with both signatures', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    expect(view.actions.set_supplier?.signatures).toEqual({ need: 2, signed: [] });
    expect(view.actions.refuse?.signatures).toEqual({ need: 1, signed: [] });

    const first = await approveProposal(deps, p.id, signApproval(view, second));
    expect(sent).toHaveLength(0);
    expect(first.status).toBe('pending');
    expect(first.actions.set_supplier?.signatures).toEqual({ need: 2, signed: [1] });
    expect(first.actions.approve_order?.signatures).toEqual({ need: 2, signed: [1] });

    const done = await approveProposal(deps, p.id, signApproval(view, owner));
    expect(done.status).toBe('approved');
    expect(functionsSent()).toEqual(['setSupplier', 'approveOrder']);
    expect(sent.map((t) => signersOf(t.data))).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(sent.map((t) => t.gas)).toEqual([
      ownerGas('setSupplier', 2),
      ownerGas('approveOrder', 2),
    ]);
  });

  it('lets any one owner refuse it', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    const refused = await refuseProposal(
      deps,
      p.id,
      browser(second, view.actions.refuse?.challenge ?? '0x'),
    );
    expect(refused.status).toBe('refused');
    expect(sent).toHaveLength(0);
  });

  it('refuses a stranger’s passkey before anything is stored', async () => {
    const p = await proposed();
    const view = await proposalApprovalView(deps, p);
    expect(await refusal(approveProposal(deps, p.id, signApproval(view, stranger)))).toEqual({
      status: 422,
      code: 'invalid_passkey',
    });
    expect((await proposalApprovalView(deps, p)).actions.set_supplier?.signatures).toEqual({
      need: 2,
      signed: [],
    });
  });
});
