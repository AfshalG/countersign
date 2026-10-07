/**
 * The stop button on a live gateway (Slice 9 part 3): a fresh judge account is paused with its
 * passkey; a clean invoice is then held ("The owner has paused the account"); unpaused, that held
 * payment is paid once with the same passkey. No service token on the owner calls. Spends about
 * 0.14 MON and 0.01 USDC.
 *
 *   pnpm --filter @countersign/gateway pause-smoke [gateway URL]
 */
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { SoftPasskey } from './passkey.js';

const gateway = process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app';
const owner = SoftPasskey.fromScalar(`0x${randomBytes(32).toString('hex')}`);
const assertion = (challenge: Hex) => {
  const s = owner.sign(challenge);
  return {
    authenticatorData: s.authenticatorData,
    clientDataJSON: s.clientDataJSON,
    signature: { r: s.r, s: s.s },
  };
};
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  return json;
}
type Owner = {
  paused: boolean;
  actions: Record<string, { challenge: Hex; deadline: number; summary: string }>;
};
const flip = async (account: Address, action: 'pause' | 'unpause') => {
  const view = await call<Owner>('GET', `/v1/owner/${account}`);
  const a = view.actions[action];
  if (!a) throw new Error(`${action} not offered`);
  const t = Date.now();
  const after = await call<Owner>('POST', `/v1/owner/${account}`, {
    action,
    deadline: a.deadline,
    assertion: assertion(a.challenge),
  });
  console.log(
    `${action} ("${a.summary}"): paused=${String(after.paused)} in ${String(Date.now() - t)} ms`,
  );
};

const created = await call<{ account: Address; actions: { challenge: Hex }[] }>(
  'POST',
  '/v1/demo/accounts',
  {
    publicKey: { x: owner.qx, y: owner.qy },
  },
);
await call('POST', `/v1/demo/accounts/${created.account}/setup`, {
  assertions: created.actions.map((a) => assertion(a.challenge)),
});
console.log(`account ${created.account} ready`);
// The demo order is indexed a moment after setup; wait for it before paying.
for (let i = 0; i < 45; i++) {
  const v = await call<{ order: unknown }>('GET', `/v1/demo/accounts/${created.account}`);
  if (v.order) break;
  await new Promise((r) => setTimeout(r, 1_000));
}

await flip(created.account, 'pause');
type Invoice = { status: string; requestId: Hex; reasonText: string | null };
let held: Invoice | undefined;
for (let i = 0; i < 20 && !held; i++) {
  try {
    held = await call<Invoice>('POST', `/v1/demo/accounts/${created.account}/invoices`, {
      kind: 'clean',
    });
  } catch (e) {
    if (!String(e).includes('order_used_up')) throw e;
    await new Promise((r) => setTimeout(r, 1_500)); // the order is still being indexed
  }
}
if (!held) throw new Error('no invoice could be paid');
console.log(`clean invoice while paused: ${held.status} (${held.reasonText ?? ''})`);

await flip(created.account, 'unpause');
type Approval = {
  status: string;
  actions: Record<string, { challenge: Hex }>;
  summary: { txHash: Hex | null };
};
const view = await call<Approval>('GET', `/v1/approvals/${held.requestId}`);
const t = Date.now();
await call('POST', `/v1/approvals/${held.requestId}`, {
  action: 'pay_once',
  assertion: assertion(view.actions.pay_once?.challenge as Hex),
});
let after = await call<Approval>('GET', `/v1/approvals/${held.requestId}`);
while (after.status !== 'settled' && Date.now() - t < 30_000) {
  await new Promise((r) => setTimeout(r, 300));
  after = await call<Approval>('GET', `/v1/approvals/${held.requestId}`);
}
console.log(
  `paid once after unpausing: ${after.status} in ${String(Date.now() - t)} ms, tx ${after.summary.txHash ?? 'none'}`,
);
