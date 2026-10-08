/**
 * The approvals API on a live gateway (Slice 9): a held payment paid once with the owner's
 * passkey, and another refused, both through GET/POST /v1/approvals/{id} with no service token on
 * the approval calls, as the approver app does it. The passkey is Slice 5's software key for the
 * demo account (SLICE5_OWNER_P256_KEY); on a phone it is Face ID. Spends one payment. Before
 * paying, it asks Monad what a one-owner `payWithOwner` needs (eth_estimateGas), against the
 * gateway's fixed limit (D36).
 *
 *   pnpm --filter @countersign/gateway approvals-smoke [gateway URL]
 */
import { z } from 'zod';
import { createPublicClient, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { chain, GAS_LIMITS, orderVaultAbi } from '@countersign/chain';
import { Countersign } from '@countersign/sdk';
import { loadEnv } from '@countersign/shared';
import { SoftPasskey } from './passkey.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    GATEWAY_RAILWAY_SERVICE_TOKEN: z.string().min(24),
    SLICE5_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    SLICE5_OWNER_P256_KEY: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  }),
);
const gateway = process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app';
const ACCOUNT = '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9';

const cs = new Countersign({
  gateway,
  token: env.GATEWAY_RAILWAY_SERVICE_TOKEN,
  account: ACCOUNT,
  agentKey: env.SLICE5_AGENT_PRIVATE_KEY as Hex,
});
const owner = SoftPasskey.fromScalar(env.SLICE5_OWNER_P256_KEY);

type Approval = {
  status: string;
  title: string;
  summary: { reasonText?: string; vault?: Address };
  actions: Record<string, { challenge: Hex; typedData?: unknown }>;
};

async function heldPayment(number: string) {
  const orders = await cs.orders();
  const order = orders.find((o) => BigInt(o.remaining) >= 1_000n);
  if (!order) throw new Error('no open order with 0.001 USDC left');
  // The stand-in checker holds a payment whose document asks it to (until Slice 10's checker).
  const r = await cs.pay({
    order,
    invoice: {
      number,
      amount: '0.001',
      payTo: order.payTo,
      document: { testHold: 'amount_mismatch' },
    },
    wait: { timeoutMs: 20_000, pollMs: 300 },
  });
  if (r.status !== 'held') throw new Error(`expected a hold, got ${r.status}`);
  return r.id;
}

async function approval(id: string): Promise<Approval> {
  const res = await fetch(`${gateway}/v1/approvals/${id}`); // no token, as the phone calls it
  if (!res.ok) throw new Error(`GET approval: ${String(res.status)}`);
  return (await res.json()) as Approval;
}

async function decide(id: string, action: 'pay_once' | 'refuse', challenge: Hex) {
  const a = owner.sign(challenge);
  const res = await fetch(`${gateway}/v1/approvals/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action,
      assertion: {
        authenticatorData: a.authenticatorData,
        clientDataJSON: a.clientDataJSON,
        signature: { r: a.r, s: a.s },
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as Approval & { error?: string } };
}

const tag = String(Date.now());

const first = await heldPayment(`APPROVE-${tag}`);
const shown = await approval(first);
console.log(
  `held: ${shown.title}; ${shown.summary.reasonText ?? ''}; actions: ${Object.keys(shown.actions).join(', ')}`,
);
// What a one-owner pay-once needs on Monad, against the gateway's fixed limit (fees are charged
// on the limit there, so the limit is fixed rather than estimated per payment).
const payOnce = shown.actions.pay_once;
const m = (
  payOnce?.typedData as {
    message: { amount: string; invoiceHash: Hex; payTo: Address; deadline: string };
  }
).message;
const health = (await (await fetch(`${gateway}/health`)).json()) as {
  relayers: { address: Address }[];
};
const needed = await createPublicClient({ chain, transport: http() }).estimateGas({
  account: health.relayers[0]?.address ?? '0x0000000000000000000000000000000000000001',
  to: shown.summary.vault as Address,
  data: encodeFunctionData({
    abi: orderVaultAbi,
    functionName: 'payWithOwner',
    args: [
      {
        amount: BigInt(m.amount),
        invoiceHash: m.invoiceHash,
        payTo: m.payTo,
        deadline: BigInt(m.deadline),
      },
      [{ owner: 0, auth: owner.sign(payOnce?.challenge as Hex) }],
    ],
  }),
});
console.log(
  `payWithOwner, one owner: Monad estimates ${needed.toLocaleString()} gas; the gateway sends ${GAS_LIMITS.payWithOwner.toLocaleString()}`,
);
const t0 = Date.now();
const paid = await decide(first, 'pay_once', shown.actions.pay_once?.challenge as Hex);
console.log(`pay_once: ${String(paid.status)} ${paid.body.status}`);
const settled = await cs.waitFor(first, { timeoutMs: 30_000, pollMs: 300 });
console.log(
  `then: ${settled.status} in ${String(Date.now() - t0)} ms, transaction ${settled.tx.hash ?? 'none'}`,
);

const second = await heldPayment(`REFUSE-${tag}`);
const refused = await decide(
  second,
  'refuse',
  (await approval(second)).actions.refuse?.challenge as Hex,
);
console.log(`refuse: ${String(refused.status)} ${refused.body.status}`);
const replay = await decide(first, 'pay_once', shown.actions.pay_once?.challenge as Hex);
console.log(`the same approval again: ${String(replay.status)} ${replay.body.error ?? ''}`);
