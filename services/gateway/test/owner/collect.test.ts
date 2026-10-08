import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { collect, progress, type Ownership } from '../../src/owner/collect.js';
import { OwnerActionError } from '../../src/owner/send.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';

/**
 * Several approvers (D36): the gateway gathers owners' assertions for one action until the
 * account's threshold is met, then hands the contract the signatures in owner order. The contract
 * counts them (D32); the gateway only gathers them, refusing what could never count.
 */

let database: Database;
let store: Store;
const ACCOUNT: Address = '0x5555555555555555555555555555555555555555';
const alice = SoftPasskey.fromScalar(`0x${'99'.repeat(32)}`);
const bob = SoftPasskey.fromScalar(`0x${'77'.repeat(32)}`);
const stranger = SoftPasskey.fromScalar(`0x${'aa'.repeat(32)}`);
const key = (p: SoftPasskey) => ({ qx: p.qx, qy: p.qy });
const digest = keccak256(stringToHex('add Kalibre Studio, nonce 4'));

let ownership: Ownership;
const chain = { ownership: () => Promise.resolve(ownership) };
const deps = () => ({ store, chain });
const sign = (p: SoftPasskey, d: Hex = digest) => p.sign(d);
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof OwnerActionError) return e.code;
    throw e;
  }
  return 'none';
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
  ownership = { owners: [key(alice), key(bob)], manage: 2, release: 1 };
});

const add = (p: SoftPasskey, threshold: 'manage' | 'release' | 'one' = 'manage') =>
  collect(deps(), {
    account: ACCOUNT,
    digest,
    auth: sign(p),
    threshold,
    purpose: 'set_supplier',
  });

describe('gathering owners’ signatures (D36)', () => {
  it('sends a one-owner account’s signature at once, as owner 0, storing nothing', async () => {
    ownership = { owners: [key(alice)], manage: 1, release: 1 };
    const got = await add(alice);
    expect(got).toMatchObject({ ready: true, sigs: [{ owner: 0 }] });
    expect(await store.ownerSignatures(digest)).toHaveLength(0);
  });

  it('waits for the second owner when manage is 2, then gives both in owner order', async () => {
    expect(await add(bob)).toEqual({ ready: false, need: 2, signed: [1] });
    const got = await add(alice);
    expect(got.ready).toBe(true);
    if (got.ready) expect(got.sigs.map((s) => s.owner)).toEqual([0, 1]);
  });

  it('counts the same owner once, however often they sign', async () => {
    await add(alice);
    expect(await add(alice)).toEqual({ ready: false, need: 2, signed: [0] });
  });

  it('needs one owner where the threshold is one, and finds which owner signed', async () => {
    const got = await add(bob, 'release');
    expect(got).toMatchObject({ ready: true, sigs: [{ owner: 1 }] });
    expect(await add(bob, 'one')).toMatchObject({ ready: true, sigs: [{ owner: 1 }] });
  });

  it('refuses a passkey that is not an owner’s, and stores nothing', async () => {
    expect(await refusal(add(stranger))).toBe('invalid_passkey');
    expect(await store.ownerSignatures(digest)).toHaveLength(0);
  });

  it('refuses an assertion over another action', async () => {
    const other = collect(deps(), {
      account: ACCOUNT,
      digest,
      auth: sign(alice, keccak256(stringToHex('something else'))),
      threshold: 'manage',
      purpose: 'set_supplier',
    });
    expect(await refusal(other)).toBe('challenge_mismatch');
  });

  it('drops a signature whose owner was removed before the action went out', async () => {
    await add(bob);
    ownership = { owners: [key(alice), key(stranger)], manage: 2, release: 1 };
    expect(await add(alice)).toEqual({ ready: false, need: 2, signed: [0] });
  });

  it('follows an owner to a new index after the owners change', async () => {
    await add(bob);
    ownership = { owners: [key(bob), key(alice)], manage: 2, release: 1 };
    const got = await add(alice);
    expect(got.ready).toBe(true);
    if (got.ready)
      expect(got.sigs.map((s) => [s.owner, s.auth.r])).toEqual([
        [0, expect.any(String)],
        [1, expect.any(String)],
      ]);
  });

  it('says what an action still needs, for the views', async () => {
    expect(await progress(deps(), ACCOUNT, digest, 'manage')).toEqual({ need: 2, signed: [] });
    await add(bob);
    expect(await progress(deps(), ACCOUNT, digest, 'manage')).toEqual({ need: 2, signed: [1] });
    expect(await progress(deps(), ACCOUNT, digest, 'one')).toEqual({ need: 1, signed: [1] });
  });
});
