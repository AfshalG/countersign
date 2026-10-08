/**
 * The hosted demo account's order, opened on a quote (Slice 14). The order D36 opened for the
 * main account was given a label for its hash, so the checker had no quote to compare prices
 * with. This closes that order (its USDC goes back to the account) and opens a standing order with
 * Kalibre Studio on its quote Q-2210: the agent proposes it through the gateway, the owner approves
 * it with the account's passkey (Slice 5's software key), and the order's hash is the quote's.
 * Spends about 0.06 MON.
 *
 *   pnpm --filter @countersign/gateway main-account-order [amount USDC, default 0.04]
 */
import { z } from 'zod';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  hashTypedData,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, countersignAccountAbi } from '@countersign/chain';
import { Countersign } from '@countersign/sdk';
import { accountDomain, loadEnv, ownerActionTypes } from '@countersign/shared';
import { pageText } from '@countersign/scripted-agent';
import { SoftPasskey } from './passkey.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    GATEWAY_RAILWAY_SERVICE_TOKEN: z.string().min(24),
    SLICE5_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    SLICE5_OWNER_P256_KEY: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
);
const amount = process.argv[2] ?? '0.04';
const gateway = 'https://gateway-production-e17a.up.railway.app';
const site = 'https://countersign-supplier-demo.vercel.app';
const ACCOUNT: Address = '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9';
const OLD_ORDER = keccak256(stringToHex('demo order 2026-010')); // D36Testnet.s.sol's MAIN_ORDER
const owner = SoftPasskey.fromScalar(env.SLICE5_OWNER_P256_KEY);
const reader = createPublicClient({ chain, transport: http() });
const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const writer = createWalletClient({ chain, transport: http(), account: deployer });

// 1. Close the order that has no quote (an owner action, relayed by the deployer).
const vault = await reader.readContract({
  address: ACCOUNT,
  abi: countersignAccountAbi,
  functionName: 'vaultOf',
  args: [OLD_ORDER],
});
if (vault !== '0x0000000000000000000000000000000000000000') {
  const nonce = await reader.readContract({
    address: ACCOUNT,
    abi: countersignAccountAbi,
    functionName: 'ownerNonce',
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const digest = hashTypedData({
    domain: accountDomain(chain.id, ACCOUNT),
    types: ownerActionTypes,
    primaryType: 'CloseOrder',
    message: { orderId: OLD_ORDER, nonce, deadline },
  });
  const data = encodeFunctionData({
    abi: countersignAccountAbi,
    functionName: 'closeOrder',
    args: [OLD_ORDER, nonce, deadline, [{ owner: 0, auth: owner.sign(digest) }]],
  });
  const gas = await reader.estimateGas({ account: deployer, to: ACCOUNT, data });
  const hash = await writer.sendTransaction({ to: ACCOUNT, data, gas: (gas * 13n) / 10n });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`closeOrder reverted: ${hash}`);
  console.log(`closed the order without a quote (vault ${vault}): ${hash}`);
} else console.log('the order without a quote is already closed');

// 2. The agent proposes a standing order on the quote, as it read it from the supplier's site.
const quote = pageText(await (await fetch(`${site}/quotes/q-2210?account=${ACCOUNT}`)).text());
const cs = new Countersign({
  gateway,
  token: env.GATEWAY_RAILWAY_SERVICE_TOKEN,
  account: ACCOUNT,
  agentKey: env.SLICE5_AGENT_PRIVATE_KEY as Hex,
});
const proposal = await cs.proposeOrder({
  supplier: {
    name: 'Kalibre Studio',
    website: site,
    payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEc',
  },
  amount,
  expiry: new Date(Date.now() + 30 * 86_400_000),
  document: quote,
});
console.log(`proposed: ${proposal.id} (${proposal.status})`);

// 3. The owner approves it with the account's passkey, as the phone does.
type View = { status: string; actions: Record<string, { challenge: Hex }> };
const view = (await (await fetch(`${gateway}/v1/approvals/${proposal.id}`)).json()) as View;
const sign = (challenge: Hex) => {
  const a = owner.sign(challenge);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};
const res = await fetch(`${gateway}/v1/approvals/${proposal.id}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'approve',
    assertions: Object.fromEntries(
      Object.entries(view.actions)
        .filter(([k]) => k !== 'refuse')
        .map(([k, a]) => [k, sign(a.challenge)]),
    ),
  }),
});
const decided = (await res.json()) as { status?: string; error?: string; message?: string };
if (!res.ok)
  throw new Error(`approve: ${String(res.status)} ${decided.error ?? ''} ${decided.message ?? ''}`);
console.log(`approved: ${decided.status ?? ''}`);
const orderId = keccak256(proposal.id);
for (let i = 0; i < 45; i++) {
  const order = (await cs.orders()).find((o) => o.orderId.toLowerCase() === orderId.toLowerCase());
  if (order) {
    console.log(`order ${orderId} indexed: vault ${order.vault}, ${order.remaining} base units`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1_000));
}
