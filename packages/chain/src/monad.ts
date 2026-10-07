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
  payWithOwner: 232_000n,
  recordDecision: 94_000n,
} as const;
