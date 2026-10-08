import { monadTestnet } from 'viem/chains';
import type { Address } from 'viem';

/** Monad testnet. Mainnet (143) only after an explicit decision (D5). */
export const chain = monadTestnet;

export const USDC: Address = '0x534b2f3A21130d7a60830c2Df862319e593943A3';

/** Slice 5 deployment on testnet (contracts/deployments/10143.json). */
export const deployments = {
  accountFactory: '0x094250cCC1dDBd8530e4FC9A1C900db3D0D9EB5f',
  accountTemplate: '0x282cf7AD04f666C1b704B91f1911C8A21c705f02',
  vaultTemplate: '0x9950941673E7479c5b20c8603cC24981c386A59D',
} as const satisfies Record<string, Address>;

/**
 * The public testnet endpoints and the share of each one's limit used for sends and for reads (Spike 3:
 * Monad 50/s with eth_call capped at 15/s, Ankr 300 per 10 s, monadinfra 20/s).
 * `poolStatus`: whether txpool_statusByHash works there (Ankr refuses it).
 */
export const ENDPOINTS = [
  {
    url: 'https://testnet-rpc.monad.xyz',
    sendsPerSecond: 30,
    readsPerSecond: 10,
    poolStatus: true,
  },
  {
    url: 'https://rpc.ankr.com/monad_testnet',
    sendsPerSecond: 25,
    readsPerSecond: 5,
    poolStatus: false,
  },
  {
    url: 'https://rpc-testnet.monadinfra.com',
    sendsPerSecond: 12,
    readsPerSecond: 6,
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
  // D36 (several owners): each limit below is for one owner's signature and was scaled from the
  // Slice 5 broadcast by the Foundry gas test's change (the owners array, thresholds and
  // OwnerSig[] encoding). The D36 testnet deployment re-measures them with eth_estimateGas.
  payWithOwner: 249_000n,
  recordDecision: 94_000n,
  // Judge mode's account setup (Slice 9 part 4), from Slice 5's testnet broadcast (197,928,
  // 153,729, 104,685 and 296,429 gas used), scaled for D36.
  createAccount: 270_000n,
  setPolicy: 173_000n,
  setSupplier: 122_000n,
  approveOrder: 331_000n,
  // The stop button (Slice 9 part 3): 88,185 and 71,664 gas in Slice 5's broadcast, plus D36's
  // encoding (about 6,000 on every owner action).
  pause: 103_000n,
  unpause: 87_000n,
  // D36: replacing the owners, for up to two keys; more keys add GAS_PER_OWNER_KEY each.
  setOwners: 230_000n,
} as const;

/**
 * What each signature beyond the first adds (D36): one more P-256 check and its calldata (about
 * 25,000 gas in Foundry on an account action; 60,000 on payWithOwner, whose vault passes the
 * signatures on to the account).
 */
export const GAS_PER_EXTRA_SIGNER = { account: 33_000n, payWithOwner: 66_000n } as const;
/** Each owner key beyond two in setOwners: two new storage slots on Monad. */
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
