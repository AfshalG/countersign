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
  // Owner actions with one owner's signature: the limits Monad charged in the D36 testnet run
  // (7 Oct; the node's estimate plus 8%), rounded up. Each extra signature adds
  // GAS_PER_EXTRA_SIGNER.
  // payWithOwner with two signatures cost 286,392 on testnet; one is about 233,000-240,000 (the
  // second signature adds about 53,000 there), checked with eth_estimateGas in the live smoke.
  payWithOwner: 249_000n,
  recordDecision: 94_000n,
  // Judge mode's account setup (Slice 9 part 4): 250,965, 164,302, 116,351 and 307,145.
  createAccount: 251_000n,
  setPolicy: 165_000n,
  setSupplier: 117_000n,
  approveOrder: 308_000n,
  // The stop button (Slice 9 part 3): pause 98,579; unpause with two signatures 104,401, so
  // about 82,500 with one.
  pause: 99_000n,
  unpause: 84_000n,
  // Owners (D36): one owner adding a second, 132,325; more keys add GAS_PER_OWNER_KEY each.
  setOwners: 133_000n,
} as const;

/**
 * What each signature beyond the first adds (D36): one more P-256 check and its calldata. On
 * testnet, 21,798 (setSupplier) and 21,981 (approveOrder); payWithOwner passes the signatures on
 * from the vault to the account (60,292 in Foundry, about 53,000 on testnet).
 */
export const GAS_PER_EXTRA_SIGNER = { account: 24_000n, payWithOwner: 60_000n } as const;
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
