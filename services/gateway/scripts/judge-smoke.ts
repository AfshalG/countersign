/**
 * Judge mode on a live gateway (Slice 9 part 4), as a new judge's phone does it: a fresh passkey
 * (a software one here; Face ID on a phone) gets an account, signs its three setup actions, and
 * the order appears in the gateway's index. No service token on the judge-mode calls. Spends
 * about 0.09 MON and 0.01 USDC.
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
console.log(`explorer: https://testnet.monadexplorer.com/address/${created.account}`);
