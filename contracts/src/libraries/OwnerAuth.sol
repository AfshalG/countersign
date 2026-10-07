// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Policy} from "../CountersignTypes.sol";

/// @notice EIP-712 types for every owner action, and the passkey check.
/// @dev Each action carries the account's current nonce and a deadline, so a signed
/// action works once and only for a while. The digest is always computed here, never
/// taken from the caller: P256 with a caller-chosen zero hash is forgeable for any key
/// (see contracts/test/Toolchain.t.sol), and WebAuthn.verify hashes everything itself.
library OwnerAuth {
    bytes32 internal constant SET_POLICY_TYPEHASH = keccak256(
        "SetPolicy(address agentKey,address checkerKey,uint128 perPaymentCap,uint128 newAddressCap,uint64 newAddressPeriod,uint64 waitingPeriod,uint64 expiry,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant SET_SUPPLIER_TYPEHASH = keccak256(
        "SetSupplier(bytes32 supplierId,address payTo,bool active,bytes32 proofHash,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant APPROVE_ORDER_TYPEHASH = keccak256(
        "ApproveOrder(bytes32 orderId,bytes32 supplierId,bytes32 orderHash,uint256 amount,uint64 expiry,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant CLOSE_ORDER_TYPEHASH =
        keccak256("CloseOrder(bytes32 orderId,uint256 nonce,uint64 deadline)");
    bytes32 internal constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address to,uint256 amount,uint256 nonce,uint64 deadline)");
    bytes32 internal constant PAUSE_TYPEHASH = keccak256("Pause(uint256 nonce,uint64 deadline)");
    bytes32 internal constant UNPAUSE_TYPEHASH = keccak256("Unpause(uint256 nonce,uint64 deadline)");

    /// True if the passkey (qx, qy) signed `digest`, with user verification (Face ID,
    /// fingerprint or PIN), as a `webauthn.get` ceremony, with a low-s signature.
    function verify(bytes32 digest, WebAuthn.WebAuthnAuth memory auth, bytes32 qx, bytes32 qy)
        internal
        view
        returns (bool)
    {
        return WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy, true);
    }

    function setPolicyHash(Policy memory p, uint256 nonce, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SET_POLICY_TYPEHASH,
                p.agentKey,
                p.checkerKey,
                p.perPaymentCap,
                p.newAddressCap,
                p.newAddressPeriod,
                p.waitingPeriod,
                p.expiry,
                nonce,
                deadline
            )
        );
    }

    function setSupplierHash(
        bytes32 supplierId,
        address payTo,
        bool active,
        bytes32 proofHash,
        uint256 nonce,
        uint64 deadline
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(SET_SUPPLIER_TYPEHASH, supplierId, payTo, active, proofHash, nonce, deadline));
    }

    function approveOrderHash(
        bytes32 orderId,
        bytes32 supplierId,
        bytes32 orderHash,
        uint256 amount,
        uint64 expiry,
        uint256 nonce,
        uint64 deadline
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(APPROVE_ORDER_TYPEHASH, orderId, supplierId, orderHash, amount, expiry, nonce, deadline)
        );
    }

    function closeOrderHash(bytes32 orderId, uint256 nonce, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(CLOSE_ORDER_TYPEHASH, orderId, nonce, deadline));
    }

    function withdrawHash(address to, uint256 amount, uint256 nonce, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(WITHDRAW_TYPEHASH, to, amount, nonce, deadline));
    }

    function pauseHash(uint256 nonce, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(PAUSE_TYPEHASH, nonce, deadline));
    }

    function unpauseHash(uint256 nonce, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(UNPAUSE_TYPEHASH, nonce, deadline));
    }
}
