/**
 * What every owner action needs on Monad (D36), measured with Monad's own eth_estimateGas on the
 * calls the gateway makes, signed by the gateway's software passkey (scripts/passkey.ts). Fees are
 * charged on the gas limit on Monad, so the gateway sends fixed limits (GAS_LIMITS); this is where
 * they come from. Uses a judge-mode account (the same passkey always gets the same one) and sends
 * each action from the deployer with a generous limit, after estimating it: one owner, then two.
 * Spends about 0.4 MON and 0.003 USDC.
 *
 *   pnpm --filter @countersign/gateway gas-calibrate [passkey scalar] [gateway URL]
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  hashTypedData,
  http,
  keccak256,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, countersignAccountAbi, orderVaultAbi } from '@countersign/chain';
import {
  accountDomain,
  decisionTypes,
  loadEnv,
  OUTCOME,
  ownerActionTypes,
  paymentTypes,
  supplierId,
  vaultDomain,
} from '@countersign/shared';
import { SoftPasskey } from './passkey.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    SLICE5_CHECKER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
);
const scalar = (process.argv[2] ?? `0x${randomBytes(32).toString('hex')}`) as Hex;
const gateway = process.argv[3] ?? 'https://gateway-production-e17a.up.railway.app';
const a = SoftPasskey.fromScalar(scalar);
const b = SoftPasskey.fromScalar(keccak256(stringToHex(`second owner of ${scalar}`)));
const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const checker = privateKeyToAccount(env.SLICE5_CHECKER_PRIVATE_KEY as Hex);
const reader = createPublicClient({ chain, transport: http() });
const writer = createWalletClient({ chain, transport: http(), account: deployer });

// 1. The judge-mode account for passkey A (created and funded by the gateway, one owner).
const created = (await (
  await fetch(`${gateway}/v1/demo/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey: { x: a.qx, y: a.qy } }),
  })
).json()) as { account: Address; actions: { typedData: { message: Record<string, string> } }[] };
const account = created.account;
const policyMessage = created.actions[0]?.typedData.message;
if (!policyMessage) throw new Error('no setup actions: has this account been set up already?');
console.log(`account ${account}`);

const domain = accountDomain(chain.id, account);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
const nonce = async () =>
  reader.readContract({ address: account, abi: countersignAccountAbi, functionName: 'ownerNonce' });
type Signer = SoftPasskey;
const sigs = (digest: Hex, signers: [number, Signer][]) =>
  signers.map(([owner, p]) => ({ owner, auth: p.sign(digest) }));
const measured: [string, bigint][] = [];

/** Estimates, then sends with 30% more than the estimate, and waits for success. */
async function run(what: string, to: Address, data: Hex) {
  const gas = await reader.estimateGas({ account: deployer, to, data });
  measured.push([what, gas]);
  const hash = await writer.sendTransaction({ to, data, gas: (gas * 13n) / 10n });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${what} reverted: ${hash}`);
  console.log(`${what.padEnd(36)} ${gas.toLocaleString().padStart(9)}  ${hash}`);
}

/** An owner action on the account, signed by the given owners over its EIP-712 digest. */
async function ownerAction(
  what: string,
  primaryType: keyof typeof ownerActionTypes,
  message: Record<string, unknown>,
  functionName: string,
  args: (n: bigint, s: ReturnType<typeof sigs>) => readonly unknown[],
  signers: [number, Signer][],
) {
  const n = await nonce();
  const digest = hashTypedData({
    domain,
    types: ownerActionTypes,
    primaryType,
    message: { ...message, nonce: n, deadline } as never,
  });
  const data = encodeFunctionData({
    abi: countersignAccountAbi,
    functionName: functionName as never,
    args: args(n, sigs(digest, signers)),
  });
  await run(what, account, data);
}

const policy = {
  agentKey: policyMessage.agentKey as Address,
  checkerKey: policyMessage.checkerKey as Address,
  perPaymentCap: BigInt(policyMessage.perPaymentCap ?? '0'),
  newAddressCap: BigInt(policyMessage.newAddressCap ?? '0'),
  newAddressPeriod: BigInt(policyMessage.newAddressPeriod ?? '0'),
  waitingPeriod: BigInt(policyMessage.waitingPeriod ?? '0'),
  expiry: BigInt(policyMessage.expiry ?? '0'),
};
const one: [number, Signer][] = [[0, a]];
const both: [number, Signer][] = [
  [0, a],
  [1, b],
];
const KALIBRE: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
const supplier = (name: string, payTo: Address, signers: [number, Signer][]) =>
  ownerAction(
    `setSupplier (${String(signers.length)})`,
    'SetSupplier',
    { supplierId: supplierId(name), payTo, active: true, proofHash: zeroHash },
    'setSupplier',
    (n, s) => [supplierId(name), payTo, true, zeroHash, n, deadline, s],
    signers,
  );
const order = (name: string, tag: string, amount: bigint, signers: [number, Signer][]) => {
  const m = {
    orderId: keccak256(stringToHex(tag)),
    supplierId: supplierId(name),
    orderHash: keccak256(stringToHex(`${tag} document`)),
    amount,
    expiry: deadline + 30n * 86_400n,
  };
  return ownerAction(
    `approveOrder (${String(signers.length)})`,
    'ApproveOrder',
    m,
    'approveOrder',
    (n, s) => [m.orderId, m.supplierId, m.orderHash, m.amount, m.expiry, n, deadline, s],
    signers,
  );
};
const stop = (action: 'pause' | 'unpause', signers: [number, Signer][]) =>
  ownerAction(
    `${action} (${String(signers.length)})`,
    action === 'pause' ? 'Pause' : 'Unpause',
    {},
    action,
    (n, s) => [n, deadline, s],
    signers,
  );

/** The checker holds a payment in the vault, then the owners pay it once. */
async function payOnce(tag: string, signers: [number, Signer][]) {
  const vault = await reader.readContract({
    address: account,
    abi: countersignAccountAbi,
    functionName: 'vaultOf',
    args: [keccak256(stringToHex(tag))],
  });
  const payment = {
    amount: 1_000n,
    invoiceHash: keccak256(stringToHex(`${tag} invoice ${String(Date.now())}`)),
    payTo: KALIBRE,
    deadline,
  };
  const decision = {
    invoiceHash: payment.invoiceHash,
    outcome: OUTCOME.held,
    reasonHash: keccak256(stringToHex('amount_mismatch')),
    evidenceHash: keccak256(stringToHex('calibration')),
  };
  const vd = vaultDomain(chain.id, vault);
  const checkerSig = await checker.signTypedData({
    domain: vd,
    types: decisionTypes,
    primaryType: 'Decision',
    message: decision,
  });
  await run(
    'recordDecision',
    vault,
    encodeFunctionData({
      abi: orderVaultAbi,
      functionName: 'recordDecision',
      args: [decision, checkerSig],
    }),
  );
  const digest = hashTypedData({
    domain: vd,
    types: paymentTypes,
    primaryType: 'Payment',
    message: payment,
  });
  await run(
    `payWithOwner (${String(signers.length)})`,
    vault,
    encodeFunctionData({
      abi: orderVaultAbi,
      functionName: 'payWithOwner',
      args: [payment, sigs(digest, signers)],
    }),
  );
}

// 2. One owner: judge mode's setup, a pay-once, the stop button.
await ownerAction(
  'setPolicy (1)',
  'SetPolicy',
  policy,
  'setPolicy',
  (n, s) => [policy, n, deadline, s],
  one,
);
await supplier('kalibre-studio', KALIBRE, one);
await order('kalibre-studio', 'calibration order 1', 3_000n, one);
await payOnce('calibration order 1', one);
await stop('pause', one);
await stop('unpause', one);

// 3. A second owner, then every action with two signatures.
const keys = [
  { qx: a.qx, qy: a.qy },
  { qx: b.qx, qy: b.qy },
];
await ownerAction(
  'setOwners (1 signer, 2 keys)',
  'SetOwners',
  { owners: keys, manage: 2, release: 2 },
  'setOwners',
  (n, s) => [keys, 2, 2, n, deadline, s],
  one,
);
await supplier('northwind-prints', '0x2e1b1cf3be4c0d5ba1d6f2b6e3c9a7d8f0e1b2c3', both);
await order('kalibre-studio', 'calibration order 2', 2_000n, both);
await stop('pause', [[1, b]]);
await stop('unpause', both);
await payOnce('calibration order 2', both);

console.log('\nMonad eth_estimateGas, by action:');
for (const [what, gas] of measured) console.log(`  ${what.padEnd(36)} ${gas.toLocaleString()}`);
