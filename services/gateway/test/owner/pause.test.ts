import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { countersignAccountAbi } from '@countersign/chain';
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
