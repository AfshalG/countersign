// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Base} from "../helpers/Base.sol";
import {PasskeySigner} from "../helpers/PasskeySigner.sol";
import {OrderVault} from "../../src/OrderVault.sol";
import {Policy, Payment, Decision, DecidedBy, OUTCOME_HELD, OUTCOME_REFUSED} from "../../src/CountersignTypes.sol";
import "../../src/CountersignErrors.sol";

contract VaultPayTest is Base {
    OrderVault vault;
    bytes32 constant INVOICE = keccak256("invoice INV-0042, PDF");

    function setUp() public override {
        super.setUp();
        vault = _readyVault();
    }

    function test_BothSignaturesPayTheSupplier() public {
        vm.expectEmit(address(vault));
        emit OrderVault.PaymentExecuted(INVOICE, supplierAddr, 10_000, 40_000, DecidedBy.Checker);
        _pay(vault, _payment(10_000, INVOICE));
        assertEq(usdc.balanceOf(supplierAddr), 10_000);
        assertEq(vault.remaining(), 40_000);
        assertEq(vault.spent(), 10_000);
        assertTrue(vault.paid(INVOICE));
    }

    function test_AnyoneMaySendACorrectlySignedPayment() public {
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.prank(makeAddr("some relayer"));
        vault.pay(p, a, c);
        assertEq(usdc.balanceOf(supplierAddr), 10_000);
    }

    function test_TheCheckerSignatureAloneIsNotEnough() public {
        Payment memory p = _payment(10_000, INVOICE);
        (, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(InvalidAgentSignature.selector);
        vault.pay(p, "", c);
    }

    function test_TheAgentSignatureAloneIsNotEnough() public {
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a,) = _sigs(vault, p);
        vm.expectRevert(InvalidCheckerSignature.selector);
        vault.pay(p, a, "");
    }

    function test_SwappedRolesAreRefused() public {
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(InvalidAgentSignature.selector);
        vault.pay(p, c, a);
    }

    function test_SignaturesForAnotherVaultAreRefused() public {
        _setSupplier(keccak256("other"), makeAddr("other wallet"), true);
        vm.warp(vm.getBlockTimestamp() + WAIT);
        OrderVault other =
            _approveOrder(keccak256("order 2"), SUPPLIER, 50_000, uint64(vm.getBlockTimestamp() + 30 days));
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(other, p); // signed for the other vault
        vm.expectRevert(InvalidAgentSignature.selector);
        vault.pay(p, a, c);
    }

    function test_SignaturesForAnotherChainAreRefused() public {
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.chainId(143);
        vm.expectRevert(InvalidAgentSignature.selector);
        vault.pay(p, a, c);
    }

    function test_SignaturesForAnotherInvoiceAreRefused() public {
        (bytes memory a, bytes memory c) = _sigs(vault, _payment(10_000, INVOICE));
        vm.expectRevert(InvalidAgentSignature.selector);
        vault.pay(_payment(10_000, keccak256("another invoice")), a, c);
    }

    function test_PaysOnlyTheAddressOnFile() public {
        Payment memory p = _payment(10_000, INVOICE);
        p.payTo = makeAddr("look-alike wallet");
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(PayToNotOnFile.selector);
        vault.pay(p, a, c);
    }

    function test_AChangedAddressIsPaidOnlyAfterItsWaitingPeriod() public {
        address moved = makeAddr("supplier's new wallet");
        _setSupplier(SUPPLIER, moved, true);
        Payment memory p = _payment(10_000, INVOICE);
        p.payTo = moved;
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(AddressNotYetActive.selector);
        vault.pay(p, a, c);
        vm.warp(vm.getBlockTimestamp() + WAIT);
        p.deadline = _deadline();
        _pay(vault, p);
        assertEq(usdc.balanceOf(moved), 10_000);
    }

    function test_RefusesASupplierThatWasTurnedOff() public {
        _setSupplier(SUPPLIER, supplierAddr, false);
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(SupplierInactive.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesMoreThanTheNewAddressCap() public {
        Payment memory p = _payment(NEW_CAP + 1, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(OverNewAddressCap.selector);
        vault.pay(p, a, c);
    }

    function test_TheNormalCapAppliesOnceTheAddressIsNoLongerNew() public {
        vm.warp(vm.getBlockTimestamp() + NEW_PERIOD);
        _pay(vault, _payment(NEW_CAP + 1, INVOICE));
        assertEq(usdc.balanceOf(supplierAddr), NEW_CAP + 1);
    }

    function test_RefusesMoreThanTheCap() public {
        vm.warp(vm.getBlockTimestamp() + NEW_PERIOD);
        Payment memory p = _payment(CAP + 1, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(OverCap.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesMoreThanIsLeftInTheOrder() public {
        vm.warp(vm.getBlockTimestamp() + NEW_PERIOD);
        _pay(vault, _payment(45_000, INVOICE));
        Payment memory p = _payment(5_001, keccak256("second invoice"));
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(OverRemaining.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesTheSameInvoiceTwice() public {
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vault.pay(p, a, c);
        vm.expectRevert(AlreadyPaid.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesAZeroAmount() public {
        Payment memory p = _payment(0, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(ZeroAmount.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesWhilePaused() public {
        _pause();
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(AccountPaused.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesAfterTheOrderExpires() public {
        vm.warp(vault.expiry() + 1);
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(OrderExpired.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesAfterTheOrderIsClosed() public {
        _closeOrder(ORDER);
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(VaultClosed.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesAfterThePaymentDeadline() public {
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.warp(p.deadline + 1);
        vm.expectRevert(DeadlinePassed.selector);
        vault.pay(p, a, c);
    }

    function test_RefusesAfterThePolicyExpires() public {
        vm.warp(account.policy().expiry + 1);
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(PolicyExpired.selector);
        vault.pay(p, a, c);
    }

    function test_ARotatedCheckerKeyStopsTheOldOne() public {
        Policy memory p2 = defaultPolicy();
        p2.checkerKey = makeAddr("new checker");
        _setPolicy(p2);
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(InvalidCheckerSignature.selector);
        vault.pay(p, a, c);
    }
}

contract VaultOwnerTest is Base {
    OrderVault vault;
    bytes32 constant INVOICE = keccak256("held invoice INV-0043");

    function setUp() public override {
        super.setUp();
        vault = _readyVault();
    }

    function _ownerAuth(Payment memory p, uint256 pk) internal view returns (WebAuthn.WebAuthnAuth memory) {
        return PasskeySigner.sign(pk, vault.paymentDigest(p));
    }

    function test_TheOwnerPaysAHeldPaymentOnce() public {
        Payment memory p = _payment(10_000, INVOICE);
        WebAuthn.WebAuthnAuth memory auth = _ownerAuth(p, OWNER_PK);
        vm.expectEmit(address(vault));
        emit OrderVault.PaymentExecuted(INVOICE, supplierAddr, 10_000, 40_000, DecidedBy.Owner);
        vault.payWithOwner(p, auth);
        assertEq(usdc.balanceOf(supplierAddr), 10_000);
        vm.expectRevert(AlreadyPaid.selector);
        vault.payWithOwner(p, auth);
    }

    function test_AnotherPasskeyCannotPay() public {
        Payment memory p = _payment(10_000, INVOICE);
        WebAuthn.WebAuthnAuth memory auth = _ownerAuth(p, OTHER_PK);
        vm.expectRevert(InvalidOwnerSignature.selector);
        vault.payWithOwner(p, auth);
    }

    function test_TheOwnerStillPaysOnlyTheAddressOnFile() public {
        Payment memory p = _payment(10_000, INVOICE);
        p.payTo = makeAddr("look-alike wallet");
        WebAuthn.WebAuthnAuth memory auth = _ownerAuth(p, OWNER_PK);
        vm.expectRevert(PayToNotOnFile.selector);
        vault.payWithOwner(p, auth);
    }

    function test_TheOwnerCannotPayWhilePaused() public {
        _pause();
        Payment memory p = _payment(10_000, INVOICE);
        WebAuthn.WebAuthnAuth memory auth = _ownerAuth(p, OWNER_PK);
        vm.expectRevert(AccountPaused.selector);
        vault.payWithOwner(p, auth);
    }

    function test_TheOwnerDoesNotNeedACurrentAgentPolicy() public {
        Policy memory shortLived = defaultPolicy();
        shortLived.expiry = uint64(vm.getBlockTimestamp() + 1 days);
        _setPolicy(shortLived);
        vm.warp(vm.getBlockTimestamp() + 2 days); // policy over, order (30 days) still open
        Payment memory p = _payment(10_000, INVOICE);
        (bytes memory a, bytes memory c) = _sigs(vault, p);
        vm.expectRevert(PolicyExpired.selector);
        vault.pay(p, a, c);
        vault.payWithOwner(p, _ownerAuth(p, OWNER_PK));
        assertEq(usdc.balanceOf(supplierAddr), 10_000);
    }
}

contract VaultCloseSweepTest is Base {
    OrderVault vault;

    function setUp() public override {
        super.setUp();
        vault = _readyVault();
    }

    function test_OnlyTheAccountCanClose() public {
        vm.expectRevert(NotAccount.selector);
        vault.close();
    }

    function test_SweepingBeforeExpiryIsRefused() public {
        vm.expectRevert(NotExpired.selector);
        vault.sweep();
    }

    function test_AnyoneCanSweepAnExpiredOrderBackToTheAccount() public {
        vm.warp(vault.expiry() + 1);
        vm.prank(makeAddr("anyone"));
        assertEq(vault.sweep(), 50_000);
        assertEq(usdc.balanceOf(address(account)), FUNDS);
        assertTrue(vault.closed());
        vm.expectRevert(VaultClosed.selector);
        vault.sweep();
    }
}

contract VaultDecisionTest is Base {
    OrderVault vault;
    bytes32 constant INVOICE = keccak256("doctored invoice INV-0044");

    function setUp() public override {
        super.setUp();
        vault = _readyVault();
    }

    function test_TheCheckerRecordsAHold() public {
        Decision memory d = _decision(INVOICE, OUTCOME_HELD);
        bytes memory sig = _ecdsa(checkerPk, vault.decisionDigest(d));
        vm.expectEmit(address(vault));
        emit OrderVault.DecisionRecorded(INVOICE, OUTCOME_HELD, d.reasonHash, d.evidenceHash, DecidedBy.Checker);
        vault.recordDecision(d, sig);
    }

    function test_TheOwnerRecordsARefusal() public {
        Decision memory d = _decision(INVOICE, OUTCOME_REFUSED);
        WebAuthn.WebAuthnAuth memory auth = PasskeySigner.sign(OWNER_PK, vault.decisionDigest(d));
        vm.expectEmit(address(vault));
        emit OrderVault.DecisionRecorded(INVOICE, OUTCOME_REFUSED, d.reasonHash, d.evidenceHash, DecidedBy.Owner);
        vault.recordDecisionByOwner(d, auth);
    }

    function test_ADecisionFromAnyoneElseIsRefused() public {
        Decision memory d = _decision(INVOICE, OUTCOME_HELD);
        bytes memory sig = _ecdsa(agentPk, vault.decisionDigest(d));
        vm.expectRevert(InvalidCheckerSignature.selector);
        vault.recordDecision(d, sig);
    }

    function test_AnUnknownOutcomeIsRefused() public {
        Decision memory d = _decision(INVOICE, 9);
        bytes memory sig = _ecdsa(checkerPk, vault.decisionDigest(d));
        vm.expectRevert(InvalidOutcome.selector);
        vault.recordDecision(d, sig);
    }

    function test_ADecisionMovesNoMoney() public {
        Decision memory d = _decision(INVOICE, OUTCOME_HELD);
        vault.recordDecision(d, _ecdsa(checkerPk, vault.decisionDigest(d)));
        assertEq(vault.remaining(), 50_000);
        assertEq(usdc.balanceOf(address(vault)), 50_000);
    }
}
