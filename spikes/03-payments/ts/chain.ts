import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { monadTestnet } from 'viem/chains';
import { settings } from './settings.js';

export const deployed = JSON.parse(
  readFileSync(new URL('../deployed.json', import.meta.url), 'utf8'),
) as {
  usdc: Address;
  factory: Address;
  implementation: Address;
  account: Address;
  checker: Address;
};

/**
 * The three public testnet endpoints, with the share of each one's limit the spike
 * uses for sending (Monad 50/s, Ankr 300 per 10 s, monadinfra 20/s). Monad's own
 * endpoint keeps headroom for reading blocks and checking the pool.
 */
export const ENDPOINTS = [
  { url: settings.MONAD_RPC_URL, sendsPerSecond: 30, poolStatus: true },
  { url: 'https://rpc.ankr.com/monad_testnet', sendsPerSecond: 25, poolStatus: false },
  { url: 'https://rpc-testnet.monadinfra.com', sendsPerSecond: 12, poolStatus: true },
] as const;
export const READ_URL = settings.MONAD_RPC_URL;

// Annotated: the inferred viem type cannot be named in a declaration file.
export const client: PublicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(settings.MONAD_RPC_URL),
});

export const USDC_PER_ORDER = 5_000n; // 0.005 USDC: room for five 0.001 payments per order
export const USDC_PER_PAYMENT = 1_000n; // 0.001 USDC
export const ORDERS = 200;

const derive = (seed: string): Address => `0x${keccak256(toHex(seed)).slice(26)}`;

/**
 * Two sets of 200 orders. s1: 200 different suppliers (the best case for vaults).
 * s2: the same 200 payments to 10 suppliers, so payments to one supplier in one block
 * share that supplier's token balance. Supplier addresses are derived; nobody holds
 * their keys, they only receive.
 */
export const SETS = {
  s1: {
    supplier: (i: number) => derive(`countersign spike 3 supplier ${String(i)}`),
    salt: (i: number): Hex => keccak256(toHex(`countersign spike 3 order ${String(i)}`)),
    accountOrderId: (i: number) => BigInt(i),
  },
  s2: {
    supplier: (i: number) => derive(`countersign spike 3 s2 supplier ${String(i % 10)}`),
    salt: (i: number): Hex => keccak256(toHex(`countersign spike 3 s2 order ${String(i)}`)),
    accountOrderId: (i: number) => BigInt(1_000 + i),
  },
} as const;
export type SetName = keyof typeof SETS;
export const isSetName = (s: string): s is SetName => s in SETS;

export type OrderSet = {
  set: SetName;
  suppliers: Address[];
  vaults: Address[];
  accountOrderIds: string[];
};
export const setFile = (set: SetName) => new URL(`../results/orders-${set}.json`, import.meta.url);

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
export const factoryAbi = parseAbi([
  'function openOrders(address[] suppliers, uint256 amount, bytes32[] salts) returns (address[])',
  'function predictVault(address supplier, bytes32 salt) view returns (address)',
]);
export const vaultAbi = parseAbi([
  'function pay(bytes32 invoiceId, uint256 amount, bytes checkerSig)',
  'function paymentDigest(bytes32 invoiceId, uint256 amount) view returns (bytes32)',
]);
export const accountAbi = parseAbi([
  'function setOrders(uint256[] orderIds, address[] suppliers, uint256 amount)',
  'function pay(uint256 orderId, bytes32 invoiceId, uint256 amount, bytes checkerSig)',
  'function paymentDigest(uint256 orderId, bytes32 invoiceId, uint256 amount) view returns (bytes32)',
  'function budget(uint256) view returns (uint256)',
]);

/** Multicall3, deployed on Monad testnet (viem's chain config lists the same address). */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const multicall3Abi = parseAbi([
  'struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)',
]);

/** EIP-712 domains, matching the contracts' constructors. */
export const vaultDomain = (vault: Address) =>
  ({
    name: 'Countersign Spike Vault',
    version: '1',
    chainId: 10143,
    verifyingContract: vault,
  }) as const;
export const accountDomain = {
  name: 'Countersign Spike Account',
  version: '1',
  chainId: 10143,
  verifyingContract: deployed.account,
} as const;
export const vaultPaymentTypes = {
  Payment: [
    { name: 'invoiceId', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'payTo', type: 'address' },
  ],
} as const;
export const accountPaymentTypes = {
  Payment: [
    { name: 'orderId', type: 'uint256' },
    { name: 'invoiceId', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'payTo', type: 'address' },
  ],
} as const;

/** JSON with bigints as strings, for result files. */
export const toJson = (value: unknown) =>
  `${JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`;
