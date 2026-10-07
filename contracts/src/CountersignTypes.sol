// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// What the owner allows the agent and checker to do. Set with the owner's passkey.
struct Policy {
    address agentKey;
    address checkerKey;
    uint128 perPaymentCap; // USDC base units (6 decimals)
    uint128 newAddressCap; // the lower cap while an address is new (D29)
    uint64 newAddressPeriod; // how long an address counts as new after it becomes active
    uint64 waitingPeriod; // how long a new or changed address waits before it can be paid (D28)
    uint64 expiry; // after this the agent and checker can pay nothing until the owner renews
}

/// A supplier the owner approved, and the one address it may be paid at.
struct Supplier {
    address payTo;
    uint64 activeAfter; // when its current address can first be paid
    bool active;
    bytes32 proofHash; // the website proof it was approved on (Slice 15); zero until then
}

/// One invoice payment from one order's vault. Signed as EIP-712 typed data in the
/// vault's own domain (chain ID and vault address, D22), by the agent and the checker,
/// or by the owner's passkey for a held payment.
struct Payment {
    uint256 amount;
    bytes32 invoiceHash;
    address payTo;
    uint64 deadline;
}

/// A held, refused or blocked outcome, recorded as an event only.
struct Decision {
    bytes32 invoiceHash;
    uint8 outcome;
    bytes32 reasonHash;
    bytes32 evidenceHash;
}

/// Everything a vault reads from its account to check a payment, in one call.
struct PaymentContext {
    address payTo;
    uint64 activeAfter;
    bool supplierActive;
    address agentKey;
    address checkerKey;
    uint128 perPaymentCap;
    uint128 newAddressCap;
    uint64 newAddressPeriod;
    uint64 policyExpiry;
    bool paused;
    bytes32 ownerQx;
    bytes32 ownerQy;
}

/// Who released a payment or recorded a decision.
enum DecidedBy {
    Checker,
    Owner
}

uint8 constant OUTCOME_HELD = 1;
uint8 constant OUTCOME_REFUSED = 2;
uint8 constant OUTCOME_BLOCKED = 3;
