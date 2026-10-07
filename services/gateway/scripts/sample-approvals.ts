/**
 * Real approvals for building the approver app against (Slice 11): on the hosted gateway, a
 * payment held because the invoice's address is not the one on file (`differences[]` filled), one
 * held for its amount, and a proposed supplier and order. Holding costs no MON: nothing is sent
 * to Monad until the owner pays once. Prints each approval's URL.
 *
 *   pnpm --filter @countersign/gateway sample-approvals [gateway URL]
 */
import { z } from 'zod';
import type { Hex } from 'viem';
import { privateKeyToAddress, generatePrivateKey } from 'viem/accounts';
import { Countersign } from '@countersign/sdk';
import { loadEnv } from '@countersign/shared';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    GATEWAY_RAILWAY_SERVICE_TOKEN: z.string().min(24),
    SLICE5_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
);
const gateway = process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app';
const cs = new Countersign({
  gateway,
  token: env.GATEWAY_RAILWAY_SERVICE_TOKEN,
  account: '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603',
  agentKey: env.SLICE5_AGENT_PRIVATE_KEY as Hex,
});

const order = (await cs.orders()).find((o) => BigInt(o.remaining) >= 1_000n);
if (!order) throw new Error('no open order with 0.001 USDC left');
const tag = String(Date.now()).slice(-6);
// An address nobody holds a key for: the look-alike an attacker would put on an invoice.
const elsewhere = privateKeyToAddress(generatePrivateKey());

const changedAddress = await cs.pay({
  order,
  invoice: { number: `SAMPLE-ADDR-${tag}`, amount: '0.001', payTo: elsewhere },
  wait: { timeoutMs: 20_000, pollMs: 300 },
});
const overAmount = await cs.pay({
  order,
  invoice: {
    number: `SAMPLE-AMT-${tag}`,
    amount: '0.001',
    payTo: order.payTo,
    // The stand-in checker holds what a document asks it to, until Slice 10's checker.
    document: { testHold: 'amount_mismatch' },
  },
  wait: { timeoutMs: 20_000, pollMs: 300 },
});
const proposal = await cs.proposeOrder({
  supplier: { name: 'Kalibre Studio', website: 'https://kalibre.example', payTo: elsewhere },
  amount: '250',
  expiry: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  document: 'Quote Q-2210 from Kalibre Studio: 50 product photos, 250 USDC, pay to ' + elsewhere,
});

for (const [what, id, status] of [
  ['changed address', changedAddress.id, changedAddress.status],
  ['amount', overAmount.id, overAmount.status],
  ['proposal', proposal.id, proposal.status],
] as const)
  console.log(`${what} (${status}): ${gateway}/v1/approvals/${id}`);
