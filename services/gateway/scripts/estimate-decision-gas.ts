/**
 * What an owner's refusal costs to record on Monad (Slice 18): Monad's own eth_estimateGas for
 * `recordDecisionByOwner` on one of the demo account's vaults, signed by its test owner passkey
 * (SLICE5_OWNER_P256_KEY). An estimate only: nothing is sent, no MON is spent.
 *
 *   pnpm --filter @countersign/gateway exec tsx scripts/estimate-decision-gas.ts <vault>
 */
import { z } from 'zod';
import {
  createPublicClient,
  encodeFunctionData,
  hashTypedData,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, orderVaultAbi } from '@countersign/chain';
import { decisionTypes, evidenceHash, loadEnv, OUTCOME, vaultDomain } from '@countersign/shared';
import { SoftPasskey } from './passkey.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    SLICE5_OWNER_P256_KEY: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  }),
);
const vault = process.argv[2] as Address | undefined;
if (!vault) throw new Error('give a vault of the demo account');
const owner = SoftPasskey.fromScalar(env.SLICE5_OWNER_P256_KEY);
const reader = createPublicClient({ chain, transport: http() });
const decision = {
  invoiceHash: keccak256(stringToHex(`estimate ${String(Date.now())}`)),
  outcome: OUTCOME.refused,
  reasonHash: keccak256(stringToHex('refused by the owner')),
  evidenceHash: evidenceHash({ estimate: true }),
};
const digest = hashTypedData({
  domain: vaultDomain(chain.id, vault),
  types: decisionTypes,
  primaryType: 'Decision',
  message: decision,
});
const data = encodeFunctionData({
  abi: orderVaultAbi,
  functionName: 'recordDecisionByOwner',
  args: [decision, [{ owner: 0, auth: owner.sign(digest) }]],
});
const gas = await reader.estimateGas({
  account: privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex),
  to: vault,
  data,
});
console.log(`recordDecisionByOwner (one owner): ${gas.toLocaleString()}`);
