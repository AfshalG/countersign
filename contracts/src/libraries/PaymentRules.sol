// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Payment, Decision, PaymentContext} from "../CountersignTypes.sol";
import "../CountersignErrors.sol";

/// What a vault knows about itself when it checks a payment.
struct VaultState {
    uint256 funded;
    uint256 spent;
    uint64 expiry;
    bool closed;
    bool alreadyPaid;
}

/// @notice The rules every payment passes, whoever signed it (agent and checker, or the
/// owner's passkey). Written once so that, if a payment ever moved out of the vault,
/// the rules and their tests would move with it unchanged.
library PaymentRules {
    bytes32 internal constant PAYMENT_TYPEHASH =
        keccak256("Payment(uint256 amount,bytes32 invoiceHash,address payTo,uint64 deadline)");
    bytes32 internal constant DECISION_TYPEHASH =
        keccak256("Decision(bytes32 invoiceHash,uint8 outcome,bytes32 reasonHash,bytes32 evidenceHash)");

    function hashPayment(Payment memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(PAYMENT_TYPEHASH, p.amount, p.invoiceHash, p.payTo, p.deadline));
    }

    function hashDecision(Decision memory d) internal pure returns (bytes32) {
        return keccak256(abi.encode(DECISION_TYPEHASH, d.invoiceHash, d.outcome, d.reasonHash, d.evidenceHash));
    }

    /// @dev Cheapest and most general refusals first; each has its own error so the
    /// reason reaches the person reviewing it.
    function check(Payment memory p, PaymentContext memory ctx, VaultState memory v) internal view {
        if (block.timestamp > p.deadline) revert DeadlinePassed();
        if (p.amount == 0) revert ZeroAmount();
        if (ctx.paused) revert AccountPaused();
        if (v.closed) revert VaultClosed();
        if (block.timestamp > v.expiry) revert OrderExpired();
        if (v.alreadyPaid) revert AlreadyPaid();
        if (!ctx.supplierActive) revert SupplierInactive();
        // The address comes from the supplier record on chain (money rule 2); the signed
        // payment only has to agree with it.
        if (p.payTo != ctx.payTo) revert PayToNotOnFile();
        if (block.timestamp < ctx.activeAfter) revert AddressNotYetActive();
        bool isNew = block.timestamp < uint256(ctx.activeAfter) + ctx.newAddressPeriod;
        if (isNew && p.amount > ctx.newAddressCap) revert OverNewAddressCap();
        if (p.amount > ctx.perPaymentCap) revert OverCap();
        if (p.amount > v.funded - v.spent) revert OverRemaining();
    }
}
