/**
 * Spike 2: checks the recorded supplier proof with the testnet probe, read-only and
 * then in a transaction that waits for finality. Run: pnpm verify:testnet [label] [payTo]
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { toSolidityAttestation } from './encode.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
  throw new Error('DEPLOYER_PRIVATE_KEY missing or invalid in .env');

const deployed = JSON.parse(readFileSync(new URL('../deployed.json', import.meta.url), 'utf8')) as {
  probe: Address;
};
const label = process.argv[2] ?? 'supplier';
const payTo = (process.argv[3] ?? '0x90f9931B748B26763161a8191C178Fe425C25fEc') as Address;
const url = 'https://countersign-supplier-demo.vercel.app/.well-known/countersign.json';
const att = toSolidityAttestation(
  JSON.parse(
    readFileSync(new URL(`../test/fixtures/attestation-${label}.json`, import.meta.url), 'utf8'),
  ),
);

const probeAbi = parseAbi([
  'struct AttNetworkRequest { string url; string header; string method; string body; }',
  'struct AttNetworkResponseResolve { string keyName; string parseType; string parsePath; }',
  'struct Attestor { address attestorAddr; string url; }',
  'struct Attestation { address recipient; AttNetworkRequest request; AttNetworkResponseResolve[] reponseResolve; string data; string attConditions; uint64 timestamp; string additionParams; Attestor[] attestors; bytes[] signatures; }',
  'function verify(Attestation att, string url, address payTo) view returns (bool)',
  'function record(Attestation att, string url, address payTo) returns (bool)',
  'event SupplierProofChecked(address indexed payTo, bytes32 indexed urlHash, bool ok, bytes4 reason, uint256 gasUsed)',
]);

const account = privateKeyToAccount(key as Hex);
const transport = http(process.env.MONAD_RPC_URL);
const publicClient = createPublicClient({ chain: monadTestnet, transport });
const wallet = createWalletClient({ account, chain: monadTestnet, transport });

let readOnly: string;
try {
  await publicClient.readContract({
    address: deployed.probe,
    abi: probeAbi,
    functionName: 'verify',
    args: [att, url, payTo],
  });
  readOnly = 'accepted';
} catch (error) {
  readOnly = `rejected: ${error instanceof Error ? (error.message.split('\n').find((l) => /Error:|reverted/.test(l)) ?? error.message.split('\n')[0] ?? '') : String(error)}`;
}

const args = [att, url, payTo] as const;
const gas = await publicClient.estimateContractGas({
  account,
  address: deployed.probe,
  abi: probeAbi,
  functionName: 'record',
  args,
});
const started = Date.now();
const hash = await wallet.writeContract({
  address: deployed.probe,
  abi: probeAbi,
  functionName: 'record',
  args,
  gas: (gas * 12n) / 10n,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 200 });
const msToReceipt = Date.now() - started;
let msToFinalized: number | null = null;
while (Date.now() - started < 15_000) {
  const finalized = await publicClient.getBlock({ blockTag: 'finalized' });
  if (finalized.number >= receipt.blockNumber) {
    msToFinalized = Date.now() - started;
    break;
  }
  await new Promise((r) => setTimeout(r, 200));
}
const [event] = parseEventLogs({
  abi: probeAbi,
  eventName: 'SupplierProofChecked',
  logs: receipt.logs,
});
console.log(
  JSON.stringify(
    {
      label,
      payTo,
      readOnly,
      recorded: event
        ? { ok: event.args.ok, reason: event.args.reason, checkGas: String(event.args.gasUsed) }
        : null,
      txGas: String(receipt.gasUsed),
      msToReceipt,
      msToFinalized,
      explorer: `https://testnet.monadvision.com/tx/${hash}`,
    },
    null,
    2,
  ),
);
process.exit(0);
