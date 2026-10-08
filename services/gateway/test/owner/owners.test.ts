import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { countersignAccountAbi, ownerGas } from '@countersign/chain';
import { accountDomain, ownerActionTypes } from '@countersign/shared';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { changeOwners, previewOwners } from '../../src/owner/owners.js';
import { ownerView, type PauseDeps } from '../../src/owner/pause.js';
import { OwnerActionError } from '../../src/owner/send.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { CHAIN_ID, demoDeps, type FakeDemoChain } from '../demo/fakes.js';

/**
 * Changing an account's owners and thresholds (D36): `setOwners`, signed by the manage threshold
 * of the current owners. The phone makes the new passkey, previews the change, and each current
 * owner signs the same challenge.
 */

let database: Database;
let store: Store;
let chain: FakeDemoChain;
let sent: { to: Address; data: Hex; gas: bigint }[];
let deps: PauseDeps;
const ACCOUNT: Address = '0x4444444444444444444444444444444444444444';
const owner = SoftPasskey.fromScalar(`0x${'99'.repeat(32)}`);
const second = SoftPasskey.fromScalar(`0x${'88'.repeat(32)}`);
const third = SoftPasskey.fromScalar(`0x${'66'.repeat(32)}`);
const stranger = SoftPasskey.fromScalar(`0x${'aa'.repeat(32)}`);
const pub = (p: SoftPasskey) => ({ x: p.qx, y: p.qy });
const key = (p: SoftPasskey) => ({ qx: p.qx, qy: p.qy });
const by = (p: SoftPasskey, digest: Hex) => {
  const a = p.sign(digest);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof OwnerActionError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error('expected a refusal');
};
const decoded = (t: { data: Hex }) =>
  decodeFunctionData({ abi: countersignAccountAbi, data: t.data });

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
  chain.ownerKeys.set(ACCOUNT.toLowerCase(), key(owner));
  chain.nonces.set(ACCOUNT.toLowerCase(), 4n);
});

describe('changing the owners (D36)', () => {
  it('previews a change: the SetOwners digest at the account’s nonce, in plain words', async () => {
    const change = { owners: [pub(owner), pub(second)], manage: 2, release: 1 };
    const pv = await previewOwners(deps, ACCOUNT, change);
    expect(pv.challenge).toBe(
      hashTypedData({
        domain: accountDomain(CHAIN_ID, ACCOUNT),
        types: ownerActionTypes,
        primaryType: 'SetOwners',
        message: {
          owners: [key(owner), key(second)],
          manage: 2,
          release: 1,
          nonce: 4n,
          deadline: BigInt(pv.deadline),
        },
      }),
    );
    expect(pv.signatures).toEqual({ need: 1, signed: [] });
    expect(pv.summary).toMatch(/2 owners/);
    expect(pv.summary).toMatch(/any one/i);
  });

  it('lets a single owner add a second at once; from then on managing needs both', async () => {
    const change = { owners: [pub(owner), pub(second)], manage: 2, release: 1 };
    const pv = await previewOwners(deps, ACCOUNT, change);
    const result = await changeOwners(
      deps,
      ACCOUNT,
      { ...change, deadline: pv.deadline },
      by(owner, pv.challenge),
    );
    expect(result).toEqual({ waiting: false });
    const after = await ownerView(deps, ACCOUNT);
    expect(sent.map((t) => decoded(t).functionName)).toEqual(['setOwners']);
    expect(sent[0]?.gas).toBe(ownerGas('setOwners', 1, 2));
    expect(after).toMatchObject({ manage: 2, release: 1 });
    expect(after.owners.map((o) => o.qx)).toEqual([owner.qx, second.qx]);
  });

  it('waits for the second owner when two must sign, and shows the waiting change to them', async () => {
    chain.extraOwners.set(ACCOUNT.toLowerCase(), [key(second)]);
    chain.thresholds.set(ACCOUNT.toLowerCase(), { manage: 2, release: 1 });
    const change = { owners: [pub(owner), pub(second), pub(third)], manage: 2, release: 2 };
    const pv = await previewOwners(deps, ACCOUNT, change);
    expect(pv.signatures).toEqual({ need: 2, signed: [] });

    expect(
      await changeOwners(
        deps,
        ACCOUNT,
        { ...change, deadline: pv.deadline },
        by(owner, pv.challenge),
      ),
    ).toEqual({ waiting: true });
    expect(sent).toHaveLength(0);
    // The second owner opens the account and finds the change waiting for them.
    const [pending] = (await ownerView(deps, ACCOUNT)).ownerChanges;
    expect(pending).toMatchObject({
      challenge: pv.challenge,
      deadline: pv.deadline,
      manage: 2,
      release: 2,
      signatures: { need: 2, signed: [0] },
    });

    await changeOwners(
      deps,
      ACCOUNT,
      { owners: change.owners, manage: 2, release: 2, deadline: pv.deadline },
      by(second, pv.challenge),
    );
    const done = await ownerView(deps, ACCOUNT);
    const call = decoded(sent[0] ?? { data: '0x' });
    expect(call.functionName).toBe('setOwners');
    expect((call.args.at(-1) as readonly { owner: number }[]).map((s) => s.owner)).toEqual([0, 1]);
    expect(done.owners).toHaveLength(3);
    expect(done.ownerChanges).toEqual([]);
  });

  it('refuses sets that could never work before anyone signs', async () => {
    const bad = async (owners: { x: Hex; y: Hex }[], manage: number, release: number) =>
      refusal(previewOwners(deps, ACCOUNT, { owners, manage, release }));
    const many = [owner, second, third, stranger, owner, second].map(pub);
    expect(await bad([], 1, 1)).toEqual({ status: 400, code: 'bad_owners' });
    expect(await bad(many, 1, 1)).toEqual({ status: 400, code: 'bad_owners' });
    expect(await bad([pub(owner), pub(owner)], 1, 1)).toEqual({ status: 400, code: 'bad_owners' });
    expect(await bad([pub(owner), pub(second)], 0, 1)).toEqual({ status: 400, code: 'bad_owners' });
    expect(await bad([pub(owner), pub(second)], 1, 3)).toEqual({ status: 400, code: 'bad_owners' });
  });

  it('refuses a passkey that is not an owner’s, and an old or far deadline', async () => {
    chain.extraOwners.set(ACCOUNT.toLowerCase(), [key(second)]);
    const change = { owners: [pub(owner), pub(third)], manage: 1, release: 1 };
    const pv = await previewOwners(deps, ACCOUNT, change);
    expect(
      await refusal(
        changeOwners(
          deps,
          ACCOUNT,
          { ...change, deadline: pv.deadline },
          by(stranger, pv.challenge),
        ),
      ),
    ).toEqual({ status: 422, code: 'invalid_passkey' });
    const now = Math.floor(Date.now() / 1000);
    for (const deadline of [now - 1, now + 2 * 86_400])
      expect(
        await refusal(
          changeOwners(deps, ACCOUNT, { ...change, deadline }, by(owner, pv.challenge)),
        ),
      ).toEqual({ status: 400, code: 'bad_deadline' });
  });
});
