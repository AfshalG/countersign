// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Base} from "./helpers/Base.sol";
import {PasskeySigner} from "./helpers/PasskeySigner.sol";
import {OrderVault} from "../src/OrderVault.sol";
import {OwnerAuth} from "../src/libraries/OwnerAuth.sol";
import {Payment} from "../src/CountersignTypes.sol";

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
        WebAuthn.WebAuthnAuth memory auth = _ownerSign(OwnerAuth.setPolicyHash(defaultPolicy(), n, dl));
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
        WebAuthn.WebAuthnAuth memory ownerAuth = PasskeySigner.sign(OWNER_PK, vault.paymentDigest(p));
        g = gasleft();
        vault.payWithOwner(p, ownerAuth);
        emit log_named_uint("payWithOwner (passkey)", g - gasleft());
    }
}
