/**
 * Brings every relayer up to a target MON balance from the deployer, in one Multicall3
 * transaction: under 10 MON a Monad account can move MON out only once per 3 blocks (Spike 3),
 * so one batched transfer beats one per relayer. Refuses to send unless the relayer keys in .env
 * are exactly the wallets the hosted gateway reports in /health.
 *
 *   pnpm --filter @countersign/gateway top-up [target MON per relayer, default 0.25]
 */
import { z } from 'zod';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseAbi,
  parseEther,
  type Hex,
} from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { chain } from '@countersign/chain';
import { loadEnv } from '@countersign/shared';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    RELAYER_PRIVATE_KEYS: z.string().min(66),
  }),
);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const GATEWAY = 'https://gateway-production-e17a.up.railway.app';
const target = parseEther(process.argv[2] ?? '0.25');

const relayers = env.RELAYER_PRIVATE_KEYS.split(',').map((k) =>
  privateKeyToAddress(k.trim() as Hex),
);
const health = (await (await fetch(`${GATEWAY}/health`)).json()) as {
  relayers?: { address: string }[];
};
const hosted = new Set((health.relayers ?? []).map((r) => r.address.toLowerCase()));
if (hosted.size !== relayers.length || !relayers.every((a) => hosted.has(a.toLowerCase())))
  throw new Error('the relayer keys in .env are not the hosted gateway’s relayers; nothing sent');

const transport = http(chain.rpcUrls.default.http[0]);
const reader = createPublicClient({ chain, transport });
const calls = [];
for (const address of relayers) {
  const balance = await reader.getBalance({ address });
  if (balance < target)
    calls.push({
      target: address,
      allowFailure: false,
      value: target - balance,
      callData: '0x' as Hex,
    });
}
const total = calls.reduce((sum, c) => sum + c.value, 0n);
if (calls.length === 0) {
  console.log(`every relayer already holds ${formatEther(target)} MON or more`);
  process.exit(0);
}
const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const before = await reader.getBalance({ address: deployer.address });
if (before < total + parseEther('0.05'))
  throw new Error(`the deployer holds ${formatEther(before)} MON, short of ${formatEther(total)}`);

const wallet = createWalletClient({ account: deployer, chain, transport });
const hash = await wallet.writeContract({
  address: MULTICALL3,
  abi: parseAbi([
    'function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
  ]),
  functionName: 'aggregate3Value',
  args: [calls],
  value: total,
});
const receipt = await reader.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`top-up reverted: ${hash}`);
console.log(
  `sent ${formatEther(total)} MON to ${String(calls.length)} relayers (each now ${formatEther(target)}), tx ${hash}`,
);
console.log(
  `deployer: ${formatEther(await reader.getBalance({ address: deployer.address }))} MON left`,
);
