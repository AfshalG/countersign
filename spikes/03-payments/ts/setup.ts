/**
 * Opens one set of 200 funded vaults (one per order) and sets up the same 200 orders
 * on the one-account control, funded once. Safe to re-run: skips what already exists.
 * Run: pnpm run open-orders s1   (or s2). Writes results/orders-<set>.json and results/setup-<set>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWalletClient, formatEther, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import {
  accountAbi,
  client,
  deployed,
  erc20Abi,
  factoryAbi,
  isSetName,
  ORDERS,
  SETS,
  setFile,
  toJson,
  USDC_PER_ORDER,
  type OrderSet,
} from './chain.js';
import { pacedReads } from './reads.js';
import { settings } from './settings.js';
import { predictVault } from './vaults.js';

setTimeout(() => {
  console.error('setup did not finish within 10 minutes');
  process.exit(1);
}, 600_000).unref();

const setName = process.argv[2] ?? 's1';
if (!isSetName(setName)) throw new Error(`unknown set ${setName}; use s1 or s2`);
const set = SETS[setName];

const deployer = privateKeyToAccount(settings.DEPLOYER_PRIVATE_KEY);
const wallet = createWalletClient({
  account: deployer,
  chain: monadTestnet,
  transport: http(settings.MONAD_RPC_URL),
});
const steps: { label: string; gasUsed: bigint; gasLimit: bigint; mon: string; hash: Hex }[] = [];

/** Sends with the estimate plus 7.5% (Monad's advice; fees are charged on the limit). */
async function send(
  label: string,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
) {
  const request = {
    address,
    abi,
    functionName,
    args,
    account: deployer,
    chain: monadTestnet,
  } as Parameters<typeof wallet.writeContract>[0];
  const estimate = await client.estimateContractGas(
    request as Parameters<typeof client.estimateContractGas>[0],
  );
  const gas = (estimate * 1075n) / 1000n;
  const hash = await wallet.writeContract({ ...request, gas });
  const r = await client.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 60_000 });
  if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  const mon = formatEther(gas * r.effectiveGasPrice);
  steps.push({ label, gasUsed: r.gasUsed, gasLimit: gas, mon, hash });
  console.log(`${label}: gas used ${String(r.gasUsed)} of ${String(gas)}, ${mon} MON, ${hash}`);
}

const indices = Array.from({ length: ORDERS }, (_, i) => i);
const suppliers = indices.map((i) => set.supplier(i));
// Vault addresses are computed locally (no requests), then the first is checked against the factory.
const vaults = indices.map((i) =>
  predictVault(deployed, deployer.address, suppliers[i] as Address, set.salt(i)),
);
const onChain = await client.readContract({
  address: deployed.factory,
  abi: factoryAbi,
  functionName: 'predictVault',
  args: [suppliers[0] as Address, set.salt(0)],
  account: deployer.address,
});
if (onChain !== vaults[0])
  throw new Error(`local vault address ${String(vaults[0])} differs from the factory's ${onChain}`);
const codes = await pacedReads<Hex>(ORDERS, 'eth_getCode', (i) => [vaults[i], 'latest']);
const missing = indices.filter((i) => codes[i] === undefined || codes[i] === '0x');
console.log(
  `${setName}: ${String(ORDERS - missing.length)} vaults already open, ${String(missing.length)} to open`,
);

if (missing.length > 0) {
  const needed = USDC_PER_ORDER * BigInt(missing.length);
  const allowance = await client.readContract({
    address: deployed.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [deployer.address, deployed.factory],
  });
  if (allowance < needed)
    await send('approve factory', deployed.usdc, erc20Abi, 'approve', [deployed.factory, needed]);
  for (let start = 0; start < missing.length; start += 50) {
    const batch = missing.slice(start, start + 50);
    await send(`open ${String(batch.length)} vaults`, deployed.factory, factoryAbi, 'openOrders', [
      batch.map((i) => suppliers[i]),
      USDC_PER_ORDER,
      batch.map((i) => set.salt(i)),
    ]);
  }
}

const orderIds = indices.map((i) => set.accountOrderId(i));
const lastBudget = await client.readContract({
  address: deployed.account,
  abi: accountAbi,
  functionName: 'budget',
  args: [orderIds[ORDERS - 1] as bigint],
});
if (lastBudget === 0n) {
  for (let start = 0; start < ORDERS; start += 50) {
    const ids = orderIds.slice(start, start + 50);
    await send('set 50 account orders', deployed.account, accountAbi, 'setOrders', [
      ids,
      ids.map((_, k) => suppliers[start + k]),
      USDC_PER_ORDER,
    ]);
  }
  await send('fund account', deployed.usdc, erc20Abi, 'transfer', [
    deployed.account,
    USDC_PER_ORDER * BigInt(ORDERS),
  ]);
}

mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
const orders: OrderSet = { set: setName, suppliers, vaults, accountOrderIds: orderIds.map(String) };
writeFileSync(setFile(setName), toJson(orders));
if (steps.length > 0)
  writeFileSync(
    new URL(`../results/setup-${setName}.json`, import.meta.url),
    toJson({ at: new Date().toISOString(), steps }),
  );
console.log(`setup ${setName} done`);
process.exit(0);
