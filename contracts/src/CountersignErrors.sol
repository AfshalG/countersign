// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Every way a Countersign contract refuses something. One name per rule, so the gateway,
// the approver app and the audit record can say exactly why.

// --- owner actions ---
error InvalidOwnerKey();
error InvalidOwnerSignature();
/// Fewer owners signed than the action needs (D36).
error NotEnoughSigners();
/// Owner signatures must come in strictly increasing owner order: none counts twice.
error OwnersOutOfOrder();
/// A signature names an owner the account does not have.
error UnknownOwner();
/// An owner set that cannot work: none, more than five, a key twice, or a threshold of zero
/// or above the number of owners.
error InvalidOwners();
error BadNonce();
error DeadlinePassed();
error InvalidPolicy();
error SameAgentAndChecker();
error InvalidPayTo();
error UnknownSupplier();
error SupplierInactive();
error OrderExists();
error UnknownOrder();
error InvalidOrder();
error InsufficientBalance();
error AlreadyPaused();
error NotPaused();

// --- payments ---
error ZeroAmount();
error AccountPaused();
error VaultClosed();
error OrderExpired();
error AlreadyPaid();
error PayToNotOnFile();
error AddressNotYetActive();
error OverNewAddressCap();
error OverCap();
error OverRemaining();
error PolicyNotSet();
error PolicyExpired();
error InvalidAgentSignature();
error InvalidCheckerSignature();

// --- vault housekeeping and decisions ---
error NotAccount();
error NotExpired();
error NotAVault();
error InvalidOutcome();
