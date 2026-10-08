import { monadTestnet } from 'viem/chains';
import type { Address } from 'viem';

/** Monad testnet. Mainnet (143) only after an explicit decision (D5). */
export const chain = monadTestnet;

export const USDC: Address = '0x534b2f3A21130d7a60830c2Df862319e593943A3';

/**
 * The D36 deployment on testnet, several approvers (contracts/deployments/10143.json, 7 Oct).
 * Slice 5's factory (0x094250cCC1dDBd8530e4FC9A1C900db3D0D9EB5f, deployments/10143-slice5.json)
 * and the accounts made on it stay on chain as history; this gateway no longer acts on them.
 */
export const deployments = {
  accountFactory: '0x7b21a2FF0C13f2d1c8D985232663BA6B08082464',
  accountTemplate: '0x5E1812BD0573d7f79909e519dF71b070CBc75907',
  vaultTemplate: '0x95Fff6CBcd4bD637e0DCfbB7b5cf510f109703b0',
  /** Slice 15: what suppliers' websites list, proven by Primus (trusts Spike 2's verifier proxy). */
  supplierProofs: '0xA91FBA7133F24aadf77c28769C706f71E281aE57',
} as const satisfies Record<string, Address>;

/**
 * The public testnet endpoints and the share of each one's limit used for sends and for reads (Spike 3:
 * Monad 50/s with eth_call capped at 15/s, Ankr 300 per 10 s, monadinfra 20/s).
 * `poolStatus`: whether txpool_statusByHash works there (Ankr refuses it).
 *
 * Slice 16 moved budget from sends to reads: a run of 200 sends about 20 transactions a second,
 * but checks are read-bound (each payment is simulated before the checker and before sending), so
 * reads go from 21 to 35 a second; sends keep 55, every endpoint still under its limit.
 */
export const ENDPOINTS = [
  {
    url: 'https://testnet-rpc.monad.xyz',
    sendsPerSecond: 30,
    readsPerSecond: 15,
    poolStatus: true,
  },
  {
    url: 'https://rpc.ankr.com/monad_testnet',
    sendsPerSecond: 15,
    readsPerSecond: 12,
    poolStatus: false,
  },
  {
    url: 'https://rpc-testnet.monadinfra.com',
    sendsPerSecond: 10,
    readsPerSecond: 8,
    poolStatus: true,
  },
] as const;

export const WS_URL = 'wss://testnet-rpc.monad.xyz';

/**
 * Gas limits per operation, measured on testnet in Slice 5 (execution plus about 8%). Fees
 * are charged on the limit on Monad, so these stay tight; a payment is simulated first.
 */
export const GAS_LIMITS = {
  pay: 266_000n,
  // Owner actions with one owner's signature (D36). Each is Monad's eth_estimateGas for the call
  // the gateway makes (scripts/gas-calibrate.ts, 7 Oct), times 1.08 for the estimate and 1.08
  // again for a phone's longer client data (Slice 5's rule), rounded up. Fees are charged on the
  // limit on Monad, so these are fixed, not estimated per call.
  payWithOwner: 285_000n, // 243,681
  recordDecision: 94_000n, // 86,592 (the checker's signature only)
  // Judge mode's account setup (Slice 9 part 4).
  createAccount: 251_000n, // no passkey data: the D36 broadcast's limit, which landed
  setPolicy: 198_000n, // 169,255
  setSupplier: 126_000n, // 107,733
  // Slice 15: SupplierProofs.record of a live Primus proof (1,668 bytes of calldata for the demo
  // supplier's file): Monad's eth_estimateGas 222,035 (proof-smoke, 8 Oct), x 1.08 = 239,797,
  // rounded up with room for a longer site name.
  recordSupplierProof: 250_000n,
  approveOrder: 332_000n, // 284,406
  // The stop button (Slice 9 part 3).
  pause: 107_000n, // 91,265
  unpause: 90_000n, // 76,369
  // Owners (D36): one signer setting two keys; more keys add GAS_PER_OWNER_KEY each.
  setOwners: 143_000n, // 122,512
} as const;

/**
 * What each signature beyond the first adds (D36): one more P-256 check and its client data. On
 * Monad, 20,195 (setSupplier), 20,353 (approveOrder), 20,287 (unpause) and 21,509
 * (payWithOwner, whose vault passes the signatures on to the account), times 1.08 twice.
 */
export const GAS_PER_EXTRA_SIGNER = { account: 26_000n, payWithOwner: 26_000n } as const;
/** Each owner key beyond two in setOwners: two new storage slots, priced high on Monad. */
export const GAS_PER_OWNER_KEY = 50_000n;

/** The limit for an owner action carrying `signers` signatures. */
export function ownerGas(
  action: Exclude<keyof typeof GAS_LIMITS, 'pay' | 'recordDecision' | 'createAccount'>,
  signers: number,
  keys = 0,
): bigint {
  const extra = BigInt(Math.max(0, signers - 1));
  const perSigner =
    action === 'payWithOwner' ? GAS_PER_EXTRA_SIGNER.payWithOwner : GAS_PER_EXTRA_SIGNER.account;
  const perKey = action === 'setOwners' ? BigInt(Math.max(0, keys - 2)) * GAS_PER_OWNER_KEY : 0n;
  return GAS_LIMITS[action] + extra * perSigner + perKey;
}
