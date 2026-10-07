/**
 * Tops judge mode's funding wallet up from the deployer: MON for the gas of its USDC transfers
 * (about 0.015 MON each) and the test USDC it gives each new demo account (0.01).
 *
 *   pnpm --filter @countersign/gateway fund-demo-wallet [MON target, default 0.5] [USDC target, default 2]
 */
import { z } from 'zod';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  http,
  parseEther,
  parseUnits,
  type Hex,
} from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { chain, USDC } from '@countersign/chain';
import { formatUsdc, loadEnv } from '@countersign/shared';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    DEMO_FUNDER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
);
const monTarget = parseEther(process.argv[2] ?? '0.5');
const usdcTarget = parseUnits(process.argv[3] ?? '2', 6);

const funder = privateKeyToAddress(env.DEMO_FUNDER_PRIVATE_KEY as Hex);
const transport = http(chain.rpcUrls.default.http[0]);
const reader = createPublicClient({ chain, transport });
const wallet = createWalletClient({
  account: privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex),
  chain,
  transport,
});

const mon = await reader.getBalance({ address: funder });
if (mon < monTarget) {
  const hash = await wallet.sendTransaction({ to: funder, value: monTarget - mon });
  await reader.waitForTransactionReceipt({ hash });
  console.log(`sent ${formatEther(monTarget - mon)} MON (tx ${hash})`);
}
const usdc = await reader.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [funder],
});
if (usdc < usdcTarget) {
  const hash = await wallet.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [funder, usdcTarget - usdc],
  });
  await reader.waitForTransactionReceipt({ hash });
  console.log(`sent ${formatUsdc(usdcTarget - usdc)} USDC (tx ${hash})`);
}
console.log(
  `funding wallet ${funder}: ${formatEther(await reader.getBalance({ address: funder }))} MON`,
);
