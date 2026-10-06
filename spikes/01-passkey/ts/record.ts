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
import { z } from 'zod';
import type { RecordRequest } from './request.js';

export const probeAbi = parseAbi([
  'struct WebAuthnAuth { bytes32 r; bytes32 s; uint256 challengeIndex; uint256 typeIndex; bytes authenticatorData; string clientDataJSON; }',
  'function verify(bytes challenge, WebAuthnAuth auth, bytes32 qx, bytes32 qy) view returns (bool)',
  'function record(bytes challenge, WebAuthnAuth auth, bytes32 qx, bytes32 qy, uint8 mode) returns (bool)',
  'event Verified(address indexed sender, bytes32 indexed qx, uint8 mode, bool ok, uint256 gasUsed)',
]);

// viem's built-in testnet explorer URL is outdated; Monad's docs list MonadVision.
const EXPLORER = 'https://testnet.monadvision.com';

const settingsSchema = z.object({
  MONAD_RPC_URL: z.url(),
  DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export type Settings = { rpcUrl: string; privateKey: Hex };

/** Fails closed with variable names only, never values (same rule as @countersign/shared's loadEnv). */
export function settingsFromEnv(env: Record<string, string | undefined>): Settings {
  const parsed = settingsSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Missing or invalid settings: ${names.join(', ')}`);
  }
  return {
    rpcUrl: parsed.data.MONAD_RPC_URL,
    privateKey: parsed.data.DEPLOYER_PRIVATE_KEY as Hex,
  };
}

export type RecordResult = {
  hash: Hex;
  ok: boolean;
  /** Gas used by the check itself, measured inside the contract. */
  checkGas: bigint;
  /** Gas used by the whole transaction. */
  txGas: bigint;
  msToReceipt: number;
  /** null if the block was not finalized within the wait. */
  msToFinalized: number | null;
  explorer: string;
};

/**
 * Sends PasskeyProbe.record and waits for the block to be finalized.
 * Monad charges fees on the gas limit, not gas used, so the limit is the
 * estimate plus 20% rather than a generous default.
 */
export async function recordOnMonad(
  settings: Settings,
  probe: Address,
  req: RecordRequest,
  finalizeWaitMs = 15_000,
): Promise<RecordResult> {
  const account = privateKeyToAccount(settings.privateKey);
  const transport = http(settings.rpcUrl);
  const publicClient = createPublicClient({ chain: monadTestnet, transport });
  const walletClient = createWalletClient({ account, chain: monadTestnet, transport });

  const args = [req.challenge, req.auth, req.qx, req.qy, req.mode] as const;
  const { request } = await publicClient.simulateContract({
    account,
    address: probe,
    abi: probeAbi,
    functionName: 'record',
    args,
  });
  const estimate = await publicClient.estimateContractGas({
    account,
    address: probe,
    abi: probeAbi,
    functionName: 'record',
    args,
  });

  const started = Date.now();
  const hash = await walletClient.writeContract({ ...request, gas: (estimate * 12n) / 10n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 200 });
  const msToReceipt = Date.now() - started;
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);

  const [event] = parseEventLogs({ abi: probeAbi, eventName: 'Verified', logs: receipt.logs });
  if (!event) throw new Error(`no Verified event in ${hash}`);

  let msToFinalized: number | null = null;
  while (Date.now() - started < finalizeWaitMs) {
    const finalized = await publicClient.getBlock({ blockTag: 'finalized' });
    if (finalized.number >= receipt.blockNumber) {
      msToFinalized = Date.now() - started;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    hash,
    ok: event.args.ok,
    checkGas: event.args.gasUsed,
    txGas: receipt.gasUsed,
    msToReceipt,
    msToFinalized,
    explorer: `${EXPLORER}/tx/${hash}`,
  };
}
