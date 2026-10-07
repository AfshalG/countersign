/**
 * Judge mode on a live gateway (Slice 9 part 4), as a new judge's phone does it: a fresh passkey
 * (a software one here; Face ID on a phone) gets an account, signs its three setup actions, and
 * the order appears in the gateway's index; then the demo agent pays three invoices into it and the
 * judge decides the held ones with the same passkey: a clean one settles, a look-alike address is
 * refused, an amount hold is paid once. No service token on the judge-mode or approval calls.
 * Spends about 0.14 MON and 0.01 USDC.
 *
 *   pnpm --filter @countersign/gateway judge-smoke [gateway URL]
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { loadEnv } from '@countersign/shared';
import { SoftPasskey } from './passkey.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(z.object({ GATEWAY_RAILWAY_SERVICE_TOKEN: z.string().min(24) }));
const gateway = process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app';

type View = {
  account: Address;
  status: string;
  actions: { action: string; summary: string; challenge: Hex }[];
  order: { supplier: string; amountUsdc: string } | null;
};
async function call(method: string, path: string, body?: unknown): Promise<View> {
  const res = await fetch(`${gateway}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as View & { error?: string; message?: string };
  if (!res.ok)
    throw new Error(
      `${method} ${path}: ${String(res.status)} ${json.error ?? ''} ${json.message ?? ''}`,
    );
  return json;
}

const judge = SoftPasskey.fromScalar(`0x${randomBytes(32).toString('hex')}`);
let t = Date.now();
const created = await call('POST', '/v1/demo/accounts', {
  publicKey: { x: judge.qx, y: judge.qy },
});
console.log(`created ${created.account} (${created.status}) in ${String(Date.now() - t)} ms`);
for (const a of created.actions) console.log(`  to sign: ${a.action}: ${a.summary}`);

t = Date.now();
const ready = await call('POST', `/v1/demo/accounts/${created.account}/setup`, {
  assertions: created.actions.map((a) => {
    const s = judge.sign(a.challenge);
    return {
      authenticatorData: s.authenticatorData,
      clientDataJSON: s.clientDataJSON,
      signature: { r: s.r, s: s.s },
    };
  }),
});
console.log(
  `set up (${ready.status}) in ${String(Date.now() - t)} ms: ${ready.order?.supplier ?? ''}, ${ready.order?.amountUsdc ?? ''} USDC`,
);

t = Date.now();
for (;;) {
  const res = await fetch(`${gateway}/v1/accounts/${created.account}/orders`, {
    headers: { authorization: `Bearer ${env.GATEWAY_RAILWAY_SERVICE_TOKEN}` },
  });
  const { orders } = (await res.json()) as { orders?: { remaining: string }[] };
  if (orders && orders.length > 0) {
    console.log(
      `order indexed after ${String(Date.now() - t)} ms; remaining ${orders[0]?.remaining ?? '?'} base units`,
    );
    break;
  }
  if (Date.now() - t > 45_000) throw new Error('the order was not indexed within 45 s');
  await new Promise((r) => setTimeout(r, 1_000));
}

type Invoice = { status: string; requestId: Hex; reasonText: string | null; txHash: Hex | null };
type Approval = {
  status: string;
  actions: Record<string, { challenge: Hex }>;
  summary: { txHash: Hex | null };
};
const invoice = async (kind: string) => {
  const started = Date.now();
  const r = (await call('POST', `/v1/demo/accounts/${created.account}/invoices`, {
    kind,
  })) as unknown as Invoice;
  return { ...r, ms: Date.now() - started };
};
const approval = async (id: Hex) =>
  (await (await fetch(`${gateway}/v1/approvals/${id}`)).json()) as Approval;
const decide = async (id: Hex, action: string, challenge: Hex) => {
  const s = judge.sign(challenge);
  const res = await fetch(`${gateway}/v1/approvals/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action,
      assertion: {
        authenticatorData: s.authenticatorData,
        clientDataJSON: s.clientDataJSON,
        signature: { r: s.r, s: s.s },
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as Approval };
};

const clean = await invoice('clean');
console.log(
  `clean invoice: ${clean.status} in ${String(clean.ms)} ms, tx ${clean.txHash ?? 'none'}`,
);

const changed = await invoice('changed_address');
const changedView = await approval(changed.requestId);
console.log(
  `changed address: ${changed.status} (${changed.reasonText ?? ''}); actions offered: ${Object.keys(changedView.actions).join(', ')}`,
);
const refused = await decide(
  changed.requestId,
  'refuse',
  changedView.actions.refuse?.challenge as Hex,
);
console.log(`  refused with the judge's passkey: ${String(refused.status)} ${refused.body.status}`);

const amount = await invoice('amount_mismatch');
const amountView = await approval(amount.requestId);
console.log(
  `amount hold: ${amount.status}; actions offered: ${Object.keys(amountView.actions).join(', ')}`,
);
t = Date.now();
const once = await decide(
  amount.requestId,
  'pay_once',
  amountView.actions.pay_once?.challenge as Hex,
);
let after = once.body;
while (after.status !== 'settled' && Date.now() - t < 30_000) {
  await new Promise((r) => setTimeout(r, 300));
  after = await approval(amount.requestId);
}
console.log(
  `  paid once with the judge's passkey: ${String(once.status)} ${once.body.status}, then ${after.status} in ${String(Date.now() - t)} ms, tx ${after.summary.txHash ?? 'none'}`,
);
console.log(`explorer: https://testnet.monadexplorer.com/address/${created.account}`);
