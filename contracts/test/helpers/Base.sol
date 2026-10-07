// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {AccountFactory} from "../../src/AccountFactory.sol";
import {CountersignAccount} from "../../src/CountersignAccount.sol";
import {OrderVault} from "../../src/OrderVault.sol";
import {OwnerAuth} from "../../src/libraries/OwnerAuth.sol";
import {Policy, Payment, Decision} from "../../src/CountersignTypes.sol";
import {PasskeySigner} from "./PasskeySigner.sol";
import {TestUSDC} from "./TestUSDC.sol";

/// @notice One company account owned by a software passkey, funded with test USDC, plus
/// helpers that sign every owner action with that passkey and every payment with the
/// agent and checker keys, exactly as the approver app, gateway and checker will.
abstract contract Base is Test {
    uint256 internal constant OWNER_PK = 0x8c1b7e4f2d9a6305e1c4b7a2f9d8e3c6b5a4f1e2d3c4b5a69788796a5b4c3d2e;
    uint256 internal constant OTHER_PK = 0x3e2d1c0b9a8f7e6d5c4b3a29180f7e6d5c4b3a2918273645a5b4c3d2e1f0a9b8;
    uint64 internal constant WAIT = 1 hours;
    uint64 internal constant NEW_PERIOD = 7 days;
    uint128 internal constant CAP = 100_000; // 0.10 USDC per payment
    uint128 internal constant NEW_CAP = 20_000; // 0.02 USDC while the address is new
    uint256 internal constant FUNDS = 1_000_000; // 1 USDC in the account
    bytes32 internal constant SUPPLIER = keccak256("kalibre-studio");
    bytes32 internal constant ORDER = keccak256("order-2026-001");
    bytes32 internal constant ORDER_HASH = keccak256("purchase order 2026-001, PDF");

    TestUSDC internal usdc;
    AccountFactory internal factory;
    CountersignAccount internal account;
    bytes32 internal qx;
    bytes32 internal qy;
    address internal agent;
    uint256 internal agentPk;
    address internal checker;
    uint256 internal checkerPk;
    address internal supplierAddr;

    /// Set by `_expectNext`: the helper arms vm.expectRevert right before its account call,
    /// after the reads (nonce, digest) that would otherwise consume the expectation.
    bytes4 private _expected;

    function _expectNext(bytes4 selector) internal {
        _expected = selector;
    }

    function _arm() private {
        if (_expected != bytes4(0)) {
            vm.expectRevert(_expected);
            _expected = bytes4(0);
        }
    }

    function setUp() public virtual {
        vm.warp(1_790_000_000); // a realistic clock, so expiries and periods are not near zero
        usdc = new TestUSDC();
        factory = new AccountFactory(usdc);
        (qx, qy) = PasskeySigner.publicKey(OWNER_PK);
        account = CountersignAccount(factory.createAccount(qx, qy, WAIT, bytes32("salt")));
        usdc.mint(address(account), FUNDS);
        (agent, agentPk) = makeAddrAndKey("agent");
        (checker, checkerPk) = makeAddrAndKey("checker");
        supplierAddr = makeAddr("kalibre-studio-wallet");
    }

    // ---------- owner actions, signed with the passkey ----------

    function _deadline() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp() + 1 hours);
    }

    function _ownerSign(bytes32 structHash) internal view returns (WebAuthn.WebAuthnAuth memory) {
        return PasskeySigner.sign(OWNER_PK, account.ownerDigest(structHash));
    }

    function defaultPolicy() internal view returns (Policy memory) {
        return Policy({
            agentKey: agent,
            checkerKey: checker,
            perPaymentCap: CAP,
            newAddressCap: NEW_CAP,
            newAddressPeriod: NEW_PERIOD,
            waitingPeriod: WAIT,
            expiry: uint64(vm.getBlockTimestamp() + 365 days)
        });
    }

    function _setPolicy(Policy memory p) internal {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _ownerSign(OwnerAuth.setPolicyHash(p, n, dl));
        _arm();
        account.setPolicy(p, n, dl, auth);
    }

    function _setSupplier(bytes32 id, address payTo, bool active) internal {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        bytes32 proof = bytes32(0);
        WebAuthn.WebAuthnAuth memory auth = _ownerSign(OwnerAuth.setSupplierHash(id, payTo, active, proof, n, dl));
        _arm();
        account.setSupplier(id, payTo, active, proof, n, dl, auth);
    }

    function _approveOrder(bytes32 orderId, bytes32 supplierId, uint256 amount, uint64 expiry)
        internal
        returns (OrderVault)
    {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth =
            _ownerSign(OwnerAuth.approveOrderHash(orderId, supplierId, ORDER_HASH, amount, expiry, n, dl));
        _arm();
        return OrderVault(account.approveOrder(orderId, supplierId, ORDER_HASH, amount, expiry, n, dl, auth));
    }

    function _closeOrder(bytes32 orderId) internal returns (uint256) {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _ownerSign(OwnerAuth.closeOrderHash(orderId, n, dl));
        _arm();
        return account.closeOrder(orderId, n, dl, auth);
    }

    function _withdraw(address to, uint256 amount) internal {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _ownerSign(OwnerAuth.withdrawHash(to, amount, n, dl));
        _arm();
        account.withdraw(to, amount, n, dl, auth);
    }

    function _pause() internal {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _ownerSign(OwnerAuth.pauseHash(n, dl));
        _arm();
        account.pause(n, dl, auth);
    }

    function _unpause() internal {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _ownerSign(OwnerAuth.unpauseHash(n, dl));
        _arm();
        account.unpause(n, dl, auth);
    }

    /// Policy set, supplier added and past its waiting period (still inside its new-address
    /// period), one order of 0.05 USDC approved for 30 days.
    function _readyVault() internal returns (OrderVault vault) {
        _setPolicy(defaultPolicy());
        _setSupplier(SUPPLIER, supplierAddr, true);
        vm.warp(vm.getBlockTimestamp() + WAIT);
        vault = _approveOrder(ORDER, SUPPLIER, 50_000, uint64(vm.getBlockTimestamp() + 30 days));
    }

    // ---------- payments, signed by the agent and the checker ----------

    function _payment(uint256 amount, bytes32 invoiceHash) internal view returns (Payment memory) {
        return Payment({amount: amount, invoiceHash: invoiceHash, payTo: supplierAddr, deadline: _deadline()});
    }

    function _ecdsa(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sigs(OrderVault vault, Payment memory p)
        internal
        view
        returns (bytes memory agentSig, bytes memory checkerSig)
    {
        bytes32 digest = vault.paymentDigest(p);
        return (_ecdsa(agentPk, digest), _ecdsa(checkerPk, digest));
    }

    function _pay(OrderVault vault, Payment memory p) internal {
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vault.pay(p, a, c);
    }

    function _decision(bytes32 invoiceHash, uint8 outcome) internal pure returns (Decision memory) {
        return Decision({
            invoiceHash: invoiceHash,
            outcome: outcome,
            reasonHash: keccak256("address differs from the one on file"),
            evidenceHash: keccak256("invoice.pdf")
        });
    }
}
