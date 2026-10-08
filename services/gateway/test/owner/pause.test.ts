import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { countersignAccountAbi, ownerGas } from '@countersign/chain';
import { accountDomain, ownerActionTypes } from '@countersign/shared';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { ownerView, setPaused, type PauseDeps } from '../../src/owner/pause.js';
import { OwnerActionError } from '../../src/owner/send.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { CHAIN_ID, demoDeps, type FakeDemoChain } from '../demo/fakes.js';

let database: Database;
let store: Store;
let chain: FakeDemoChain;
let sent: { to: Address; data: Hex; gas: bigint }[];
let deps: PauseDeps;
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
  ({ chain, sent } = fake);
  deps = { ...fake.deps, store, chain };
  chain.nonces.set(ACCOUNT.toLowerCase(), 7n);
  chain.ownerKeys.set(ACCOUNT.toLowerCase(), { qx: owner.qx, qy: owner.qy });
});

const browser = (digest: Hex) => {
  const a = owner.sign(digest);
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
const functionsSent = () =>
  sent.map((t) => decodeFunctionData({ abi: countersignAccountAbi, data: t.data }).functionName);

describe('the stop button: pause and unpause with the owner’s passkey', () => {
  it('offers pause on a running account, signed at the next owner nonce, valid for ten minutes', async () => {
    const now = 1_791_000_000_000;
    const view = await ownerView(deps, ACCOUNT, now);
    expect(view.paused).toBe(false);
    expect(Object.keys(view.actions)).toEqual(['pause']);
    const deadline = BigInt(now / 1000 + 600);
    expect(view.actions.pause?.deadline).toBe(Number(deadline));
    expect(view.actions.pause?.challenge).toBe(
      hashTypedData({
        domain: accountDomain(CHAIN_ID, ACCOUNT),
        types: ownerActionTypes,
        primaryType: 'Pause',
        message: { nonce: 7n, deadline },
      }),
    );
  });

  it('pauses, then offers unpause; unpausing runs it again', async () => {
    const view = await ownerView(deps, ACCOUNT);
    const paused = await setPaused(
      deps,
      ACCOUNT,
      'pause',
      view.actions.pause?.deadline ?? 0,
      browser(view.actions.pause?.challenge as Hex),
    );
    expect(paused.paused).toBe(true);
    expect(Object.keys(paused.actions)).toEqual(['unpause']);
    const again = await setPaused(
      deps,
      ACCOUNT,
      'unpause',
      paused.actions.unpause?.deadline ?? 0,
      browser(paused.actions.unpause?.challenge as Hex),
    );
    expect(again.paused).toBe(false);
    expect(functionsSent()).toEqual(['pause', 'unpause']);
  });

  it('refuses what does not fit: pausing a paused account, an old or far deadline, the wrong signature', async () => {
    const view = await ownerView(deps, ACCOUNT);
    const ok = browser(view.actions.pause?.challenge as Hex);
    expect(
      await refusal(setPaused(deps, ACCOUNT, 'unpause', view.actions.pause?.deadline ?? 0, ok)),
    ).toMatchObject({ status: 409, code: 'not_paused' });
    const past = Math.floor(Date.now() / 1000) - 5;
    expect(await refusal(setPaused(deps, ACCOUNT, 'pause', past, ok))).toMatchObject({
      status: 400,
      code: 'bad_deadline',
    });
    const far = Math.floor(Date.now() / 1000) + 86_400;
    expect(await refusal(setPaused(deps, ACCOUNT, 'pause', far, ok))).toMatchObject({
      status: 400,
      code: 'bad_deadline',
    });
    expect(
      await refusal(
        setPaused(
          deps,
          ACCOUNT,
          'pause',
          view.actions.pause?.deadline ?? 0,
          browser(`0x${'12'.repeat(32)}`),
        ),
      ),
    ).toMatchObject({ status: 422, code: 'challenge_mismatch' });
    chain.ownerKeyValid = false;
    expect(
      await refusal(setPaused(deps, ACCOUNT, 'pause', view.actions.pause?.deadline ?? 0, ok)),
    ).toMatchObject({ status: 422, code: 'invalid_passkey' });
    expect(sent).toHaveLength(0);
  });
});

describe('several approvers (D36): one owner pauses; unpausing needs the manage threshold', () => {
  const second = SoftPasskey.fromScalar(`0x${'88'.repeat(32)}`);
  const by = (p: SoftPasskey, digest: Hex) => {
    const a = p.sign(digest);
    return {
      authenticatorData: a.authenticatorData,
      clientDataJSON: a.clientDataJSON,
      signature: { r: a.r, s: a.s },
    };
  };
  const signersOf = (data: Hex) => {
    const { args } = decodeFunctionData({ abi: countersignAccountAbi, data });
    return (args.at(-1) as readonly { owner: number }[]).map((s) => s.owner);
  };

  beforeEach(() => {
    chain.extraOwners.set(ACCOUNT.toLowerCase(), [{ qx: second.qx, qy: second.qy }]);
    chain.thresholds.set(ACCOUNT.toLowerCase(), { manage: 2, release: 2 });
  });

  it('shows the owners and the thresholds', async () => {
    const v = await ownerView(deps, ACCOUNT);
    expect(v.owners).toEqual([
      { owner: 0, qx: owner.qx, qy: owner.qy },
      { owner: 1, qx: second.qx, qy: second.qy },
    ]);
    expect(v).toMatchObject({ manage: 2, release: 2 });
  });

  it('pauses with any one owner’s passkey', async () => {
    const a = (await ownerView(deps, ACCOUNT)).actions.pause;
    expect(a?.signatures).toEqual({ need: 1, signed: [] });
    await setPaused(deps, ACCOUNT, 'pause', a?.deadline ?? 0, by(second, a?.challenge ?? '0x'));
    expect(chain.pausedAccounts.has(ACCOUNT.toLowerCase())).toBe(true);
    expect(sent.map((t) => signersOf(t.data))).toEqual([[1]]);
  });

  it('unpauses once two owners sign the same challenge, with a day to do it', async () => {
    chain.pausedAccounts.add(ACCOUNT.toLowerCase());
    const now = Date.now();
    const a = (await ownerView(deps, ACCOUNT, now)).actions.unpause;
    if (!a) throw new Error('no unpause offered');
    expect(a.deadline).toBeGreaterThan(Math.floor(now / 1000) + 23 * 3_600);
    expect(a.signatures).toEqual({ need: 2, signed: [] });

    const waiting = await setPaused(deps, ACCOUNT, 'unpause', a.deadline, by(owner, a.challenge));
    expect(sent).toHaveLength(0);
    expect(waiting.paused).toBe(true);
    expect(waiting.actions.unpause).toMatchObject({
      challenge: a.challenge,
      deadline: a.deadline,
      signatures: { need: 2, signed: [0] },
    });

    // An hour later the second owner opens it: the same challenge, still one signature short.
    const later = (await ownerView(deps, ACCOUNT, now + 3_600_000)).actions.unpause;
    expect(later?.challenge).toBe(a.challenge);
    const done = await setPaused(deps, ACCOUNT, 'unpause', a.deadline, by(second, a.challenge));
    expect(done.paused).toBe(false);
    expect(sent.map((t) => signersOf(t.data))).toEqual([[0, 1]]);
    expect(sent[0]?.gas).toBe(ownerGas('unpause', 2));
  });
});
