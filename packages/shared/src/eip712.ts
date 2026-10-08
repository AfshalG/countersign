/**
 * EIP-712 typed data for every signature the contracts accept. The gateway, the checker and
 * the approver app sign these; contracts/ verifies them. Field names, order and types must
 * match the Solidity typehashes exactly (contracts/src/libraries/OwnerAuth.sol and
 * PaymentRules.sol); test/eip712.test.ts checks every digest against values computed by the
 * contracts themselves in Foundry.
 */

export type Hex = `0x${string}`;

export const EIP712_VERSION = '1';
export const ACCOUNT_DOMAIN_NAME = 'Countersign Account';
export const VAULT_DOMAIN_NAME = 'Countersign Vault';

/** Owner actions are signed in the account's domain. */
export const accountDomain = (chainId: number, account: Hex) =>
  ({
    name: ACCOUNT_DOMAIN_NAME,
    version: EIP712_VERSION,
    chainId,
    verifyingContract: account,
  }) as const;

/** Payments and decisions are signed in the vault's own domain, so they bind to one order on one chain (D22). */
export const vaultDomain = (chainId: number, vault: Hex) =>
  ({
    name: VAULT_DOMAIN_NAME,
    version: EIP712_VERSION,
    chainId,
    verifyingContract: vault,
  }) as const;

/** Signed with the owner's passkey: the WebAuthn challenge is the 32-byte digest. */
export const ownerActionTypes = {
  SetPolicy: [
    { name: 'agentKey', type: 'address' },
    { name: 'checkerKey', type: 'address' },
    { name: 'perPaymentCap', type: 'uint128' },
    { name: 'newAddressCap', type: 'uint128' },
    { name: 'newAddressPeriod', type: 'uint64' },
    { name: 'waitingPeriod', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  SetSupplier: [
    { name: 'supplierId', type: 'bytes32' },
    { name: 'payTo', type: 'address' },
    { name: 'active', type: 'bool' },
    { name: 'proofHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  ApproveOrder: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'supplierId', type: 'bytes32' },
    { name: 'orderHash', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  CloseOrder: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  Withdraw: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  Pause: [
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  Unpause: [
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  // D36: the account's owners (passkey public keys) and its manage and release thresholds.
  SetOwners: [
    { name: 'owners', type: 'OwnerKey[]' },
    { name: 'manage', type: 'uint8' },
    { name: 'release', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  OwnerKey: [
    { name: 'qx', type: 'bytes32' },
    { name: 'qy', type: 'bytes32' },
  ],
} as const;

export type OwnerAction = keyof typeof ownerActionTypes;

/** Signed by the agent and the checker (ECDSA), or by the owner's passkey for a held payment. */
export const paymentTypes = {
  Payment: [
    { name: 'amount', type: 'uint256' },
    { name: 'invoiceHash', type: 'bytes32' },
    { name: 'payTo', type: 'address' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

/** A held, refused or blocked outcome, recorded on chain as an event only. */
export const decisionTypes = {
  Decision: [
    { name: 'invoiceHash', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'reasonHash', type: 'bytes32' },
    { name: 'evidenceHash', type: 'bytes32' },
  ],
} as const;

/** Matches OUTCOME_* in contracts/src/CountersignTypes.sol. */
export const OUTCOME = { held: 1, refused: 2, blocked: 3 } as const;
