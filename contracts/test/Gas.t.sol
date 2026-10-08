// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Base} from "./helpers/Base.sol";
import {PasskeySigner} from "./helpers/PasskeySigner.sol";
import {OrderVault} from "../src/OrderVault.sol";
import {OwnerAuth} from "../src/libraries/OwnerAuth.sol";
import {Payment, OwnerSig, OwnerKey} from "../src/CountersignTypes.sol";

/// @notice Gas per operation on the local EVM, as a regression baseline. Monad prices cold
/// access and storage differently (10,100 per first account access, 8,100 per storage page),
/// so the hard-coded limits for Slice 6 come from the testnet run, not from these numbers.
contract GasTest is Base {
    function test_GasPerOperation() public {
        uint256 g = gasleft();
        factory.createAccount(qx, qy, WAIT, bytes32("gas"));
        emit log_named_uint("createAccount", g - gasleft());

        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        OwnerSig[] memory auth = _ownerSign(OwnerAuth.setPolicyHash(defaultPolicy(), n, dl));
        g = gasleft();
        account.setPolicy(defaultPolicy(), n, dl, auth);
        emit log_named_uint("setPolicy (passkey)", g - gasleft());

        n = account.ownerNonce();
        auth = _ownerSign(OwnerAuth.setSupplierHash(SUPPLIER, supplierAddr, true, 0, n, dl));
        g = gasleft();
        account.setSupplier(SUPPLIER, supplierAddr, true, 0, n, dl, auth);
        emit log_named_uint("setSupplier (passkey)", g - gasleft());

        vm.warp(vm.getBlockTimestamp() + WAIT);
        dl = _deadline();
        n = account.ownerNonce();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 30 days);
        auth = _ownerSign(OwnerAuth.approveOrderHash(ORDER, SUPPLIER, ORDER_HASH, 50_000, expiry, n, dl));
        g = gasleft();
        OrderVault vault = OrderVault(account.approveOrder(ORDER, SUPPLIER, ORDER_HASH, 50_000, expiry, n, dl, auth));
        emit log_named_uint("approveOrder (create and fund a vault)", g - gasleft());

        Payment memory p = _payment(10_000, keccak256("first invoice"));
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        g = gasleft();
        vault.pay(p, a, c);
        emit log_named_uint("pay, first payment to the supplier", g - gasleft());

        p = _payment(10_000, keccak256("second invoice"));
        (a, c) = _sigs(vault, p);
        g = gasleft();
        vault.pay(p, a, c);
        emit log_named_uint("pay, supplier already paid before", g - gasleft());

        p = _payment(10_000, keccak256("held invoice"));
        OwnerSig[] memory ownerAuth = PasskeySigner.one(OWNER_PK, vault.paymentDigest(p));
        g = gasleft();
        vault.payWithOwner(p, ownerAuth);
        emit log_named_uint("payWithOwner (passkey)", g - gasleft());

        n = account.ownerNonce();
        auth = _ownerSign(OwnerAuth.pauseHash(n, dl));
        g = gasleft();
        account.pause(n, dl, auth);
        emit log_named_uint("pause (passkey)", g - gasleft());

        n = account.ownerNonce();
        auth = _ownerSign(OwnerAuth.unpauseHash(n, dl));
        g = gasleft();
        account.unpause(n, dl, auth);
        emit log_named_uint("unpause (passkey)", g - gasleft());
    }

    uint256 internal constant SECOND_PK = 0x5a17c3e9d2b8f4016e7a3c9d5b1f8e2a6c4d0b9f7e3a1c5d8b2f6e4a0c9d7b31;

    /// Two signatures over `digest`: owner 0 and owner 1.
    function _both(bytes32 digest) internal pure returns (OwnerSig[] memory s) {
        s = new OwnerSig[](2);
        s[0] = OwnerSig({owner: 0, auth: PasskeySigner.sign(OWNER_PK, digest)});
        s[1] = OwnerSig({owner: 1, auth: PasskeySigner.sign(SECOND_PK, digest)});
    }

    /// D36: what a second approver adds. Each extra signature is one more P-256 check and its
    /// calldata; the gateway sets each limit from the number of signatures it sends.
    function test_GasWithTwoOwners() public {
        _setPolicy(defaultPolicy());
        OwnerKey[] memory keys = new OwnerKey[](2);
        (keys[0].qx, keys[0].qy) = PasskeySigner.publicKey(OWNER_PK);
        (keys[1].qx, keys[1].qy) = PasskeySigner.publicKey(SECOND_PK);
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        OwnerSig[] memory auth = _ownerSign(OwnerAuth.setOwnersHash(keys, 2, 2, n, dl));
        uint256 g = gasleft();
        account.setOwners(keys, 2, 2, n, dl, auth);
        emit log_named_uint("setOwners (one owner adds a second)", g - gasleft());

        n = account.ownerNonce();
        auth = _both(account.ownerDigest(OwnerAuth.setSupplierHash(SUPPLIER, supplierAddr, true, 0, n, dl)));
        g = gasleft();
        account.setSupplier(SUPPLIER, supplierAddr, true, 0, n, dl, auth);
        emit log_named_uint("setSupplier (two passkeys)", g - gasleft());

        vm.warp(vm.getBlockTimestamp() + WAIT);
        dl = _deadline();
        n = account.ownerNonce();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 30 days);
        auth =
            _both(account.ownerDigest(OwnerAuth.approveOrderHash(ORDER, SUPPLIER, ORDER_HASH, 50_000, expiry, n, dl)));
        g = gasleft();
        OrderVault vault = OrderVault(account.approveOrder(ORDER, SUPPLIER, ORDER_HASH, 50_000, expiry, n, dl, auth));
        emit log_named_uint("approveOrder (two passkeys)", g - gasleft());

        Payment memory p = _payment(10_000, keccak256("held invoice"));
        auth = _both(vault.paymentDigest(p));
        g = gasleft();
        vault.payWithOwner(p, auth);
        emit log_named_uint("payWithOwner (two passkeys)", g - gasleft());
    }
}
