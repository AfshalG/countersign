// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Base} from "../helpers/Base.sol";
import {PasskeySigner} from "../helpers/PasskeySigner.sol";
import {OrderVault} from "../../src/OrderVault.sol";
import {OwnerAuth} from "../../src/libraries/OwnerAuth.sol";
import {Policy, Payment, Decision} from "../../src/CountersignTypes.sol";
import "../../src/CountersignErrors.sol";

/// Every external function with random inputs: money moves only along the allowed paths.
contract FuzzTest is Base {
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    OrderVault vault;

    function setUp() public override {
        super.setUp();
        vault = _readyVault();
    }

    function _balances() internal view returns (uint256 supplierBal, uint256 vaultBal, uint256 accountBal) {
        return (usdc.balanceOf(supplierAddr), usdc.balanceOf(address(vault)), usdc.balanceOf(address(account)));
    }

    // ---------- vault.pay ----------

    function testFuzz_PayNeedsTheRealAgentAndChecker(uint256 aPk, uint256 cPk, bytes32 invoice) public {
        aPk = bound(aPk, 1, SECP256K1_N - 1);
        cPk = bound(cPk, 1, SECP256K1_N - 1);
        vm.assume(aPk != agentPk || cPk != checkerPk);
        Payment memory p = _payment(10_000, invoice);
        bytes32 digest = vault.paymentDigest(p);
        bytes memory a = _ecdsa(aPk, digest);
        bytes memory c = _ecdsa(cPk, digest);
        (uint256 before,,) = _balances();
        vm.expectRevert(aPk != agentPk ? InvalidAgentSignature.selector : InvalidCheckerSignature.selector);
        vault.pay(p, a, c);
        (uint256 afterBal,,) = _balances();
        assertEq(afterBal, before);
    }

    function testFuzz_PayRefusesGarbageSignatures(bytes calldata a, bytes calldata c, bytes32 invoice) public {
        Payment memory p = _payment(10_000, invoice);
        vm.expectRevert(InvalidAgentSignature.selector);
        vault.pay(p, a, c);
    }

    function testFuzz_PayMovesExactlyTheAmountOrNothing(uint256 amount, bytes32 invoice) public {
        vm.warp(block.timestamp + NEW_PERIOD); // past the new-address period: the normal cap applies
        amount = bound(amount, 0, uint256(type(uint128).max));
        Payment memory p = _payment(amount, invoice);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        (uint256 s0, uint256 v0,) = _balances();
        if (amount == 0) vm.expectRevert(ZeroAmount.selector);
        else if (amount > CAP) vm.expectRevert(OverCap.selector);
        else if (amount > 50_000) vm.expectRevert(OverRemaining.selector);
        vault.pay(p, a, c);
        (uint256 s1, uint256 v1,) = _balances();
        bool paid = amount > 0 && amount <= 50_000;
        assertEq(s1 - s0, paid ? amount : 0);
        assertEq(v0 - v1, paid ? amount : 0);
        assertEq(vault.spent(), paid ? amount : 0);
    }

    function testFuzz_SignersCannotChooseWhereMoneyGoes(address payTo, bytes32 invoice) public {
        vm.assume(payTo != supplierAddr);
        Payment memory p = _payment(10_000, invoice);
        p.payTo = payTo;
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        uint256 before = usdc.balanceOf(payTo);
        vm.expectRevert(PayToNotOnFile.selector);
        vault.pay(p, a, c);
        assertEq(usdc.balanceOf(payTo), before);
    }

    function testFuzz_ANewAddressIsNeverPaidBeforeItsWait(uint256 elapsed, bytes32 invoice) public {
        address moved = makeAddr("moved wallet");
        _setSupplier(SUPPLIER, moved, true);
        elapsed = bound(elapsed, 0, WAIT - 1);
        vm.warp(block.timestamp + elapsed);
        Payment memory p = _payment(10_000, invoice);
        p.payTo = moved;
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(AddressNotYetActive.selector);
        vault.pay(p, a, c);
        assertEq(usdc.balanceOf(moved), 0);
    }

    // ---------- vault.payWithOwner ----------

    function testFuzz_OnlyTheOwnersPasskeyPaysAHeldPayment(uint256 pk, bytes32 invoice) public {
        pk = bound(pk, 1, PasskeySigner.N - 1);
        vm.assume(pk != OWNER_PK);
        Payment memory p = _payment(10_000, invoice);
        WebAuthn.WebAuthnAuth memory auth = PasskeySigner.sign(pk, vault.paymentDigest(p));
        vm.expectRevert(InvalidOwnerSignature.selector);
        vault.payWithOwner(p, auth);
        assertEq(usdc.balanceOf(supplierAddr), 0);
    }

    function testFuzz_RandomAssertionsNeverPay(bytes32 r, bytes32 s, bytes32 invoice) public {
        Payment memory p = _payment(10_000, invoice);
        WebAuthn.WebAuthnAuth memory auth = PasskeySigner.sign(OWNER_PK, vault.paymentDigest(p));
        vm.assume(r != auth.r || s != auth.s);
        auth.r = r;
        auth.s = s;
        vm.expectRevert(InvalidOwnerSignature.selector);
        vault.payWithOwner(p, auth);
    }

    // ---------- vault.close, vault.sweep ----------

    function testFuzz_OnlyTheAccountCloses(address caller) public {
        vm.assume(caller != address(account));
        vm.prank(caller);
        vm.expectRevert(NotAccount.selector);
        vault.close();
    }

    function testFuzz_SweepReturnsOnlyToTheAccount(address caller, uint256 after_) public {
        after_ = bound(after_, 1, 365 days);
        vm.warp(uint256(vault.expiry()) + after_);
        (, uint256 v0, uint256 a0) = _balances();
        uint256 callerBefore = usdc.balanceOf(caller);
        vm.prank(caller);
        vault.sweep();
        (, uint256 v1, uint256 a1) = _balances();
        assertEq(v1, 0);
        assertEq(a1 - a0, v0);
        if (caller != address(account)) assertEq(usdc.balanceOf(caller), callerBefore);
    }

    // ---------- vault.recordDecision ----------

    function testFuzz_DecisionsNeverMoveMoney(uint8 outcome, bytes32 invoice, bytes32 reason) public {
        Decision memory d = Decision({invoiceHash: invoice, outcome: outcome, reasonHash: reason, evidenceHash: reason});
        bytes memory sig = _ecdsa(checkerPk, vault.decisionDigest(d));
        (uint256 s0, uint256 v0, uint256 a0) = _balances();
        if (outcome < 1 || outcome > 3) vm.expectRevert(InvalidOutcome.selector);
        vault.recordDecision(d, sig);
        (uint256 s1, uint256 v1, uint256 a1) = _balances();
        assertEq(s1, s0);
        assertEq(v1, v0);
        assertEq(a1, a0);
    }

    // ---------- owner actions ----------

    function testFuzz_OwnerActionsNeedTheOwnersPasskey(uint256 pk, address to, uint256 amount) public {
        pk = bound(pk, 1, PasskeySigner.N - 1);
        vm.assume(pk != OWNER_PK);
        uint64 dl = _deadline();
        uint256 n = account.ownerNonce();
        WebAuthn.WebAuthnAuth memory auth =
            PasskeySigner.sign(pk, account.ownerDigest(OwnerAuth.withdrawHash(to, amount, n, dl)));
        vm.expectRevert(InvalidOwnerSignature.selector);
        account.withdraw(to, amount, n, dl, auth);
        assertEq(account.ownerNonce(), n);
    }

    function testFuzz_RandomOwnerSignaturesAreRefused(bytes32 r, bytes32 s) public {
        uint64 dl = _deadline();
        uint256 n = account.ownerNonce();
        WebAuthn.WebAuthnAuth memory auth = _ownerSign(OwnerAuth.pauseHash(n, dl));
        vm.assume(r != auth.r || s != auth.s);
        auth.r = r;
        auth.s = s;
        vm.expectRevert(InvalidOwnerSignature.selector);
        account.pause(n, dl, auth);
        assertFalse(account.paused());
    }

    function testFuzz_WithdrawMovesExactlyTheSignedAmount(uint256 amount) public {
        address treasury = makeAddr("treasury");
        uint256 available = usdc.balanceOf(address(account));
        amount = bound(amount, 0, available * 2);
        if (amount == 0) _expectNext(ZeroAmount.selector);
        else if (amount > available) _expectNext(InsufficientBalance.selector);
        _withdraw(treasury, amount);
        bool ok = amount > 0 && amount <= available;
        assertEq(usdc.balanceOf(treasury), ok ? amount : 0);
    }

    function testFuzz_ApproveOrderFundsExactlyTheAmount(uint256 amount, bytes32 orderId) public {
        vm.assume(orderId != ORDER);
        uint256 available = usdc.balanceOf(address(account));
        amount = bound(amount, 0, available * 2);
        if (amount == 0) _expectNext(InvalidOrder.selector);
        else if (amount > available) _expectNext(InsufficientBalance.selector);
        OrderVault v = _approveOrder(orderId, SUPPLIER, amount, uint64(block.timestamp + 30 days));
        if (amount > 0 && amount <= available) {
            assertEq(usdc.balanceOf(address(v)), amount);
            assertEq(usdc.balanceOf(address(account)), available - amount);
        }
    }

    function testFuzz_AWaitingPeriodDecreaseNeverAppliesEarly(uint64 newWait, uint256 elapsed) public {
        newWait = uint64(bound(newWait, 0, WAIT - 1));
        elapsed = bound(elapsed, 0, WAIT - 1);
        Policy memory p = defaultPolicy();
        p.waitingPeriod = newWait;
        _setPolicy(p);
        vm.warp(block.timestamp + elapsed);
        assertEq(account.effectiveWaitingPeriod(), WAIT);
        _setSupplier(keccak256("fresh"), makeAddr("fresh wallet"), true);
        assertEq(account.supplier(keccak256("fresh")).activeAfter, block.timestamp + WAIT);
    }

    function testFuzz_ANewSupplierAddressAlwaysWaits(address payTo) public {
        vm.assume(payTo != address(0));
        _setSupplier(keccak256("any"), payTo, true);
        assertEq(account.supplier(keccak256("any")).activeAfter, block.timestamp + WAIT);
    }
}
