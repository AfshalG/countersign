/**
 * Approving proposals on a live gateway (Slice 9 part 2), as an owner does it: a fresh judge
 * account; an agent proposes a new supplier and order from a quote; the owner's passkey approves
 * (add the supplier, then open the order, two signatures); the order appears and the demo agent
 * pays the new supplier from it; a second proposal is refused. No service token on the approval
 * calls. Spends about 0.18 MON and 0.011 USDC.
 *
 *   pnpm --filter @countersign/gateway proposal-smoke [gateway URL]
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
type Approval = {
  status: string;
  summary: Record<string, unknown>;
  actions: Record<string, { challenge: Hex; summary?: string }>;
};

// 1. A fresh account for this passkey (judge mode).
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

// 2. The agent proposes a new supplier and order from a quote it read.
const agent = new Countersign({
  gateway,
  token: env.GATEWAY_RAILWAY_SERVICE_TOKEN,
  account: created.account,
  agentKey: env.DEMO_AGENT_PRIVATE_KEY as Hex,
});
const northwind = privateKeyToAddress(generatePrivateKey());
const quote = `Quote NW-${String(Date.now())} from Northwind Prints: 200 flyers, 0.002 USDC, pay to ${northwind}`;
const proposal = await agent.proposeOrder({
  supplier: { name: 'Northwind Prints', website: 'https://northwind.example', payTo: northwind },
  amount: '0.002',
  expiry: new Date(Date.now() + 30 * 86_400_000),
  document: quote,
});
const view = await call<Approval>('GET', `/v1/approvals/${proposal.id}`);
console.log(
  `proposed: actions ${Object.keys(view.actions).join(', ')}; account holds ${String(view.summary.accountUsdc)} USDC`,
);
for (const [k, a] of Object.entries(view.actions)) console.log(`  ${k}: ${a.summary ?? ''}`);

// 3. The owner approves: two signatures.
let t = Date.now();
const approved = await call<Approval>('POST', `/v1/approvals/${proposal.id}`, {
  action: 'approve',
  assertions: {
    set_supplier: assertion(view.actions.set_supplier?.challenge as Hex),
    approve_order: assertion(view.actions.approve_order?.challenge as Hex),
  },
});
console.log(`approved (${approved.status}) in ${String(Date.now() - t)} ms`);

// 4. The new order appears, and the demo agent pays Northwind from it.
t = Date.now();
let order;
while (!order) {
  order = (await agent.orders()).find((o) => o.payTo.toLowerCase() === northwind.toLowerCase());
  if (!order) {
    if (Date.now() - t > 45_000) throw new Error('the approved order was not indexed within 45 s');
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
console.log(`order indexed after ${String(Date.now() - t)} ms: ${order.remaining} base units`);
const paid = await agent.pay({
  order,
  invoice: { number: `NW-INV-${String(Date.now())}`, amount: '0.001', payTo: northwind },
  wait: { timeoutMs: 20_000, pollMs: 300 },
});
console.log(`paid Northwind: ${paid.status}, tx ${paid.tx.hash ?? 'none'}`);

// 5. A second proposal, refused with the passkey.
const other = await agent.proposeOrder({
  supplier: { name: 'Southwind Ltd', payTo: privateKeyToAddress(generatePrivateKey()) },
  amount: '0.001',
  expiry: new Date(Date.now() + 30 * 86_400_000),
  document: `Quote SW-${String(Date.now())} from Southwind Ltd`,
});
const otherView = await call<Approval>('GET', `/v1/approvals/${other.id}`);
const refused = await call<Approval>('POST', `/v1/approvals/${other.id}`, {
  action: 'refuse',
  assertion: assertion(otherView.actions.refuse?.challenge as Hex),
});
console.log(`second proposal: ${refused.status}`);
console.log(`explorer: https://testnet.monadexplorer.com/address/${created.account}`);
