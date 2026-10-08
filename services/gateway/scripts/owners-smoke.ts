/**
 * Several approvers on a live gateway (D36), as two people do it: a fresh judge account with one
 * passkey; a second person's passkey added with manage 2 and release 2; an agent proposes a
 * supplier, and approving it waits (202) until the second owner signs; a held payment is paid
 * once only when both have signed; either owner pauses alone; unpausing waits for both. No
 * service token on any owner call. Spends about 0.25 MON and 0.006 USDC.
 *
 *   pnpm --filter @countersign/gateway owners-smoke [gateway URL]
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { Countersign } from '@countersign/sdk';
import { loadEnv } from '@countersign/shared';
import { SoftPasskey } from './passkey.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    GATEWAY_RAILWAY_SERVICE_TOKEN: z.string().min(24),
    DEMO_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
);
const gateway = process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app';
const alice = SoftPasskey.fromScalar(`0x${randomBytes(32).toString('hex')}`);
const bob = SoftPasskey.fromScalar(`0x${randomBytes(32).toString('hex')}`);
const by = (p: SoftPasskey, challenge: Hex) => {
  const s = p.sign(challenge);
  return {
    authenticatorData: s.authenticatorData,
    clientDataJSON: s.clientDataJSON,
    signature: { r: s.r, s: s.s },
  };
};
async function call<T>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${gateway}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok)
    throw new Error(
      `${method} ${path}: ${String(res.status)} ${json.error ?? ''} ${json.message ?? ''}`,
    );
  return Object.assign(json, { httpStatus: res.status });
}
const expectStatus = (what: string, got: number, want: number) => {
  if (got !== want) throw new Error(`${what}: expected ${String(want)}, got ${String(got)}`);
};
type Signatures = { need: number; signed: number[] };
type Action = { challenge: Hex; deadline: number; summary?: string; signatures?: Signatures };
type Owner = {
  paused: boolean;
  owners: { owner: number }[];
  manage: number;
  release: number;
  actions: Record<string, Action>;
};
type Approval = { status: string; actions: Record<string, Action> };
const progress = (s?: Signatures) =>
  s ? `${String(s.signed.length)} of ${String(s.need)} signed` : 'no count';

// 1. A fresh account for Alice's passkey (judge mode): one owner.
const created = await call<{ account: Address; actions: { challenge: Hex }[] }>(
  'POST',
  '/v1/demo/accounts',
  {
    publicKey: { x: alice.qx, y: alice.qy },
  },
);
const account = created.account;
await call('POST', `/v1/demo/accounts/${account}/setup`, {
  assertions: created.actions.map((a) => by(alice, a.challenge)),
});
console.log(`account ${account} ready, one owner`);

// 2. Alice adds Bob: from now on managing and paying once need both of them.
const change = {
  owners: [
    { x: alice.qx, y: alice.qy },
    { x: bob.qx, y: bob.qy },
  ],
  manage: 2,
  release: 2,
};
const preview = await call<Action>('POST', `/v1/owner/${account}/owners/preview`, change);
console.log(`preview: ${preview.summary ?? ''}`);
let t = Date.now();
const added = await call<Owner>('POST', `/v1/owner/${account}/owners`, {
  ...change,
  deadline: preview.deadline,
  assertion: by(alice, preview.challenge),
});
expectStatus('adding Bob (one owner signs it)', added.httpStatus, 200);
console.log(
  `Bob added in ${String(Date.now() - t)} ms: ${String(added.owners.length)} owners, manage ${String(added.manage)}, release ${String(added.release)}`,
);

// 2b. A held payment now needs both to pay it once: Alice (202), then Bob (200, settles).
const invoice = await call<{ requestId: string; status: string }>(
  'POST',
  `/v1/demo/accounts/${account}/invoices`,
  { kind: 'amount_mismatch' },
);
const held = await call<Approval>('GET', `/v1/approvals/${invoice.requestId}`);
const payOnce = held.actions.pay_once as Action;
console.log(`held invoice: pay_once ${progress(payOnce.signatures)}`);
const payBy = (p: SoftPasskey) =>
  call<Approval>('POST', `/v1/approvals/${invoice.requestId}`, {
    action: 'pay_once',
    assertion: by(p, payOnce.challenge),
  });
const half = await payBy(alice);
expectStatus('Alice pays once alone', half.httpStatus, 202);
console.log(`Alice: 202, ${half.status}, ${progress(half.actions.pay_once?.signatures)}`);
t = Date.now();
const both = await payBy(bob);
expectStatus('Bob pays once too', both.httpStatus, 200);
let settled = both.status;
while (settled !== 'settled') {
  if (Date.now() - t > 30_000) throw new Error(`the pay-once did not settle: ${settled}`);
  await new Promise((r) => setTimeout(r, 500));
  settled = (await call<Approval>('GET', `/v1/approvals/${invoice.requestId}`)).status;
}
console.log(`Bob: paid once by both, settled in ${String(Date.now() - t)} ms`);

// 3. The agent proposes a supplier; Alice approves (202, waiting), then Bob (200, approved).
const agent = new Countersign({
  gateway,
  token: env.GATEWAY_RAILWAY_SERVICE_TOKEN,
  account,
  agentKey: env.DEMO_AGENT_PRIVATE_KEY as Hex,
});
const northwind = privateKeyToAddress(generatePrivateKey());
const proposal = await agent.proposeOrder({
  supplier: { name: 'Northwind Prints', website: 'https://northwind.example', payTo: northwind },
  amount: '0.002',
  expiry: new Date(Date.now() + 30 * 86_400_000),
  document: `Quote NW-${String(Date.now())} from Northwind Prints: 0.002 USDC, pay to ${northwind}`,
});
const view = await call<Approval>('GET', `/v1/approvals/${proposal.id}`);
console.log(`proposed: set_supplier ${progress(view.actions.set_supplier?.signatures)}`);
const approveBy = (p: SoftPasskey) =>
  call<Approval>('POST', `/v1/approvals/${proposal.id}`, {
    action: 'approve',
    assertions: {
      set_supplier: by(p, view.actions.set_supplier?.challenge as Hex),
      approve_order: by(p, view.actions.approve_order?.challenge as Hex),
    },
  });
const first = await approveBy(alice);
expectStatus('Alice approves alone', first.httpStatus, 202);
console.log(
  `Alice approved: ${String(first.httpStatus)}, ${first.status}, ${progress(first.actions.set_supplier?.signatures)}`,
);
t = Date.now();
const second = await approveBy(bob);
expectStatus('Bob approves too', second.httpStatus, 200);
console.log(`Bob approved: ${second.status} in ${String(Date.now() - t)} ms (both actions sent)`);

// 4. Bob pauses alone; unpausing needs both.
const owner = async () => await call<Owner>('GET', `/v1/owner/${account}`);
const pause = (await owner()).actions.pause as Action;
console.log(`pause: ${progress(pause.signatures)}`);
const paused = await call<Owner>('POST', `/v1/owner/${account}`, {
  action: 'pause',
  deadline: pause.deadline,
  assertion: by(bob, pause.challenge),
});
expectStatus('Bob pauses alone', paused.httpStatus, 200);
console.log(`paused by Bob alone: ${String(paused.paused)}`);
const unpause = (await owner()).actions.unpause as Action;
const halfUnpause = await call<Owner>('POST', `/v1/owner/${account}`, {
  action: 'unpause',
  deadline: unpause.deadline,
  assertion: by(alice, unpause.challenge),
});
expectStatus('Alice unpauses alone', halfUnpause.httpStatus, 202);
const again = (await owner()).actions.unpause as Action;
if (again.challenge !== unpause.challenge) throw new Error('the unpause challenge changed');
console.log(`Alice unpaused: 202, still paused, ${progress(again.signatures)}; same challenge`);
const done = await call<Owner>('POST', `/v1/owner/${account}`, {
  action: 'unpause',
  deadline: again.deadline,
  assertion: by(bob, again.challenge),
});
expectStatus('Bob unpauses too', done.httpStatus, 200);
console.log(`Bob unpaused: paused ${String(done.paused)}`);
console.log(`explorer: https://testnet.monadexplorer.com/address/${account}`);
