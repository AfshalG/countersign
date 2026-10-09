/**
 * A supplier's website proven live (Slice 15): Primus proves what the file at
 * `/.well-known/countersign.json` lists (the gateway's own prover, proxy-TLS), Monad's
 * eth_estimateGas prices recording it (the gas limit for GAS_LIMITS.recordSupplierProof), and with
 * `--record` the deployer wallet records it in the SupplierProofs registry (not the relayers, so a
 * live gateway's nonces are untouched). One Primus proof; about 0.06 MON with --record.
 *
 *   pnpm --filter @countersign/gateway proof-smoke [site] [--record]
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { chain, deployments, supplierProofsAbi } from '@countersign/chain';
import { loadEnv } from '@countersign/shared';
import { listedIn, toSolidityAttestation } from '../src/proofs/attestation.js';
import { PrimusProver } from '../src/proofs/primus.js';
import { fileUrlOf, proofHashOf } from '../src/proofs/website.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    PRIMUS_APP_ID: z.string().min(1),
    PRIMUS_APP_SECRET: z.string().min(1),
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    MONAD_RPC_URL: z.url(),
  }),
);
// The SDK keeps connections open: fail loudly instead of hanging.
setTimeout(() => {
  console.error('did not finish within 120 s');
  process.exit(1);
}, 120_000).unref();

const site =
  process.argv.find((a) => a.startsWith('https://')) ??
  'https://countersign-supplier-demo.vercel.app';
const url = fileUrlOf(site);
if (!url) throw new Error(`not an https site: ${site}`);
const registry = deployments.supplierProofs;

const prover = new PrimusProver({
  appId: env.PRIMUS_APP_ID,
  appSecret: env.PRIMUS_APP_SECRET,
  recipient: registry,
});
let t = Date.now();
const attestation = toSolidityAttestation(await prover.prove(url));
const listed = listedIn(attestation.data);
console.log(`proven in ${String(Date.now() - t)} ms: ${url} lists ${listed ?? '(no address)'}`);
if (!listed) process.exit(1);

const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
const transport = http(env.MONAD_RPC_URL);
const reader = createPublicClient({ chain, transport });
const data = encodeFunctionData({
  abi: supplierProofsAbi,
  functionName: 'record',
  args: [attestation],
});
const estimate = await reader.estimateGas({ account: deployer, to: registry, data });
console.log(
  `eth_estimateGas ${estimate.toString()}, x1.08 = ${((estimate * 108n) / 100n).toString()} (calldata ${String((data.length - 2) / 2)} bytes)`,
);

if (process.argv.includes('--record')) {
  const writer = createWalletClient({ account: deployer, chain, transport });
  t = Date.now();
  const hash = await writer.sendTransaction({ to: registry, data, gas: (estimate * 108n) / 100n });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  const proofHash = proofHashOf(url, listed, Number(attestation.timestamp / 1000n));
  const [onChain] = await reader.readContract({
    address: registry,
    abi: supplierProofsAbi,
    functionName: 'proofs',
    args: [proofHash],
  });
  console.log(
    `recorded in ${String(Date.now() - t)} ms: ${receipt.status}, gas used ${receipt.gasUsed.toString()}, tx ${hash}`,
  );
  console.log(`proof ${proofHash}: the registry says it lists ${onChain}`);
}
process.exit(0);
