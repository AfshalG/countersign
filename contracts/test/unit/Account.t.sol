// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Base} from "../helpers/Base.sol";
import {PasskeySigner} from "../helpers/PasskeySigner.sol";
import {CountersignAccount} from "../../src/CountersignAccount.sol";
import {OrderVault} from "../../src/OrderVault.sol";
import {OwnerAuth} from "../../src/libraries/OwnerAuth.sol";
import {Policy, Supplier} from "../../src/CountersignTypes.sol";
import "../../src/CountersignErrors.sol";

contract FactoryTest is Base {
    function test_CreatesAnAccountBoundToThePasskey() public view {
        (bytes32 x, bytes32 y) = account.ownerKey();
        assertEq(x, qx);
        assertEq(y, qy);
        assertEq(address(account), factory.predictAccount(qx, qy, WAIT, bytes32("salt")));
        assertEq(account.effectiveWaitingPeriod(), WAIT);
        assertEq(address(account.usdc()), address(usdc));
    }

    function test_CreatingTheSameAccountTwiceReturnsIt() public {
        assertEq(factory.createAccount(qx, qy, WAIT, bytes32("salt")), address(account));
    }

    function test_TheWaitingPeriodIsPartOfTheAddress() public view {
        // So nobody can create someone's account first with a shorter wait.
        assertTrue(factory.predictAccount(qx, qy, 0, bytes32("salt")) != address(account));
    }

    function test_AnAccountCannotBeInitialisedAgain() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        account.initialize(qx, qy, 0);
    }

    function test_TheTemplateCannotBeInitialised() public {
        CountersignAccount template = CountersignAccount(factory.accountTemplate());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        template.initialize(qx, qy, 0);
    }

    function test_RefusesAKeyThatIsNotOnTheCurve() public {
        vm.expectRevert(InvalidOwnerKey.selector);
        factory.createAccount(bytes32(uint256(1)), bytes32(uint256(2)), WAIT, bytes32("salt"));
    }

    function test_AnAccountsWaitingPeriodHasAMaximum() public {
        // Otherwise a huge wait could never be lowered in practice: a decrease waits out the current one.
        vm.expectRevert(InvalidPolicy.selector);
        factory.createAccount(qx, qy, 30 days + 1, bytes32("too long"));
    }

    function test_ANewAccountCannotPayAnything() public view {
        Policy memory p = account.policy();
        assertEq(p.agentKey, address(0));
        assertEq(p.checkerKey, address(0));
        assertEq(p.perPaymentCap, 0);
    }
}

contract OwnerAuthTest is Base {
    function _policyCall(uint256 nonce, uint64 dl, WebAuthn.WebAuthnAuth memory auth) internal {
        account.setPolicy(defaultPolicy(), nonce, dl, auth);
    }

    function _policyAuth(uint256 pk, uint256 nonce, uint64 dl) internal view returns (WebAuthn.WebAuthnAuth memory) {
        return PasskeySigner.sign(pk, account.ownerDigest(OwnerAuth.setPolicyHash(defaultPolicy(), nonce, dl)));
    }

    function test_AValidPasskeyActionPassesAndUsesItsNonce() public {
        _setPolicy(defaultPolicy());
        assertEq(account.ownerNonce(), 1);
        assertEq(account.policy().agentKey, agent);
    }

    function test_AnotherPasskeyIsRefused() public {
        WebAuthn.WebAuthnAuth memory auth = _policyAuth(OTHER_PK, 0, _deadline());
        vm.expectRevert(InvalidOwnerSignature.selector);
        _policyCall(0, _deadline(), auth);
    }

    function test_AUsedNonceIsRefused() public {
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _policyAuth(OWNER_PK, 0, dl);
        _policyCall(0, dl, auth);
        vm.expectRevert(BadNonce.selector);
        _policyCall(0, dl, auth);
    }

    function test_AnExpiredDeadlineIsRefused() public {
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _policyAuth(OWNER_PK, 0, dl);
        vm.warp(dl + 1);
        vm.expectRevert(DeadlinePassed.selector);
        _policyCall(0, dl, auth);
    }

    function test_AnAssertionWithoutUserVerificationIsRefused() public {
        uint64 dl = _deadline();
        bytes32 digest = account.ownerDigest(OwnerAuth.setPolicyHash(defaultPolicy(), 0, dl));
        WebAuthn.WebAuthnAuth memory auth =
            PasskeySigner.assertion(OWNER_PK, digest, PasskeySigner.FLAGS_UP_ONLY, "webauthn.get", false);
        vm.expectRevert(InvalidOwnerSignature.selector);
        _policyCall(0, dl, auth);
    }

    function test_AHighSSignatureIsRefused() public {
        uint64 dl = _deadline();
        bytes32 digest = account.ownerDigest(OwnerAuth.setPolicyHash(defaultPolicy(), 0, dl));
        WebAuthn.WebAuthnAuth memory auth =
            PasskeySigner.assertion(OWNER_PK, digest, PasskeySigner.FLAGS_UP_UV, "webauthn.get", true);
        vm.expectRevert(InvalidOwnerSignature.selector);
        _policyCall(0, dl, auth);
    }

    function test_ARegistrationCeremonyIsRefused() public {
        uint64 dl = _deadline();
        bytes32 digest = account.ownerDigest(OwnerAuth.setPolicyHash(defaultPolicy(), 0, dl));
        WebAuthn.WebAuthnAuth memory auth =
            PasskeySigner.assertion(OWNER_PK, digest, PasskeySigner.FLAGS_UP_UV, "webauthn.create", false);
        vm.expectRevert(InvalidOwnerSignature.selector);
        _policyCall(0, dl, auth);
    }

    function test_ASignatureForAnotherActionIsRefused() public {
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory pauseAuth = _ownerSign(OwnerAuth.pauseHash(0, dl));
        vm.expectRevert(InvalidOwnerSignature.selector);
        _policyCall(0, dl, pauseAuth);
    }

    function test_ASignatureForAnotherAccountOfTheSamePasskeyIsRefused() public {
        CountersignAccount other = CountersignAccount(factory.createAccount(qx, qy, WAIT, bytes32("other")));
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _policyAuth(OWNER_PK, 0, dl); // signed for `account`
        vm.expectRevert(InvalidOwnerSignature.selector);
        other.setPolicy(defaultPolicy(), 0, dl, auth);
    }

    function test_ASignatureForAnotherChainIsRefused() public {
        uint64 dl = _deadline();
        WebAuthn.WebAuthnAuth memory auth = _policyAuth(OWNER_PK, 0, dl);
        vm.chainId(143);
        vm.expectRevert(InvalidOwnerSignature.selector);
        _policyCall(0, dl, auth);
    }
}

contract PolicyTest is Base {
    function test_TheAgentAndCheckerMustBeDifferentKeys() public {
        Policy memory p = defaultPolicy();
        p.checkerKey = p.agentKey;
        _expectNext(SameAgentAndChecker.selector);
        _setPolicy(p);
    }

    function test_TheNewAddressCapCannotExceedTheCap() public {
        Policy memory p = defaultPolicy();
        p.newAddressCap = CAP + 1;
        _expectNext(InvalidPolicy.selector);
        _setPolicy(p);
    }

    function test_APolicyMustNotAlreadyHaveExpired() public {
        Policy memory p = defaultPolicy();
        p.expiry = uint64(block.timestamp);
        _expectNext(InvalidPolicy.selector);
        _setPolicy(p);
    }

    function test_EmitsPolicySet() public {
        Policy memory p = defaultPolicy();
        vm.expectEmit(address(account));
        emit CountersignAccount.PolicySet(agent, checker, CAP, NEW_CAP, NEW_PERIOD, WAIT, p.expiry);
        _setPolicy(p);
    }

    function test_TheCheckerKeyCanBeReplacedWhilePaused() public {
        _setPolicy(defaultPolicy());
        _pause();
        Policy memory p = defaultPolicy();
        p.checkerKey = makeAddr("new checker");
        _setPolicy(p);
        assertEq(account.policy().checkerKey, p.checkerKey);
    }

    function test_TheWaitingPeriodHasAMaximum() public {
        Policy memory p = defaultPolicy();
        p.waitingPeriod = 30 days + 1;
        _expectNext(InvalidPolicy.selector);
        _setPolicy(p);
        p.waitingPeriod = 30 days;
        _setPolicy(p);
        assertEq(account.effectiveWaitingPeriod(), 30 days);
    }

    function test_ALongerWaitingPeriodAppliesAtOnce() public {
        Policy memory p = defaultPolicy();
        p.waitingPeriod = 2 days;
        _setPolicy(p);
        assertEq(account.effectiveWaitingPeriod(), 2 days);
    }

    function test_AShorterWaitingPeriodWaitsForTheCurrentOne() public {
        Policy memory p = defaultPolicy();
        p.waitingPeriod = 10 minutes;
        _setPolicy(p);
        assertEq(account.effectiveWaitingPeriod(), WAIT); // still the old one
        _setSupplier(SUPPLIER, supplierAddr, true);
        assertEq(account.supplier(SUPPLIER).activeAfter, block.timestamp + WAIT);
        vm.warp(block.timestamp + WAIT);
        assertEq(account.effectiveWaitingPeriod(), 10 minutes);
    }
}

contract SupplierTest is Base {
    function test_ANewAddressWaitsForTheWaitingPeriod() public {
        _setSupplier(SUPPLIER, supplierAddr, true);
        Supplier memory s = account.supplier(SUPPLIER);
        assertEq(s.payTo, supplierAddr);
        assertTrue(s.active);
        assertEq(s.activeAfter, block.timestamp + WAIT);
    }

    function test_AChangedAddressWaitsAgain() public {
        _setSupplier(SUPPLIER, supplierAddr, true);
        vm.warp(block.timestamp + 3 days);
        _setSupplier(SUPPLIER, makeAddr("new wallet"), true);
        assertEq(account.supplier(SUPPLIER).activeAfter, block.timestamp + WAIT);
    }

    function test_TurningASupplierOffKeepsItsActivationTime() public {
        _setSupplier(SUPPLIER, supplierAddr, true);
        uint64 activeAfter = account.supplier(SUPPLIER).activeAfter;
        vm.warp(block.timestamp + 3 days);
        _setSupplier(SUPPLIER, supplierAddr, false);
        assertFalse(account.supplier(SUPPLIER).active);
        assertEq(account.supplier(SUPPLIER).activeAfter, activeAfter);
    }

    function test_RefusesTheZeroAddress() public {
        _expectNext(InvalidPayTo.selector);
        _setSupplier(SUPPLIER, address(0), true);
    }

    function test_EmitsSupplierSet() public {
        vm.expectEmit(address(account));
        emit CountersignAccount.SupplierSet(SUPPLIER, supplierAddr, true, uint64(block.timestamp + WAIT), bytes32(0));
        _setSupplier(SUPPLIER, supplierAddr, true);
    }
}

contract OrderTest is Base {
    function setUp() public override {
        super.setUp();
        _setPolicy(defaultPolicy());
        _setSupplier(SUPPLIER, supplierAddr, true);
    }

    function test_ApprovingAnOrderCreatesAndFundsItsVault() public {
        uint64 expiry = uint64(block.timestamp + 30 days);
        address predicted = account.predictVault(ORDER, SUPPLIER, ORDER_HASH, expiry, 50_000);
        OrderVault vault = _approveOrder(ORDER, SUPPLIER, 50_000, expiry);
        assertEq(address(vault), predicted);
        assertEq(account.vaultOf(ORDER), predicted);
        assertEq(usdc.balanceOf(address(vault)), 50_000);
        assertEq(usdc.balanceOf(address(account)), FUNDS - 50_000);
        assertEq(vault.account(), address(account));
        assertEq(vault.supplierId(), SUPPLIER);
        assertEq(vault.orderHash(), ORDER_HASH);
        assertEq(vault.expiry(), expiry);
        assertEq(vault.amount(), 50_000);
        assertEq(vault.remaining(), 50_000);
    }

    function test_RefusesAnUnknownSupplier() public {
        _expectNext(UnknownSupplier.selector);
        _approveOrder(ORDER, keccak256("nobody"), 50_000, uint64(block.timestamp + 30 days));
    }

    function test_RefusesASupplierThatIsOff() public {
        _setSupplier(SUPPLIER, supplierAddr, false);
        _expectNext(SupplierInactive.selector);
        _approveOrder(ORDER, SUPPLIER, 50_000, uint64(block.timestamp + 30 days));
    }

    function test_RefusesTheSameOrderTwice() public {
        _approveOrder(ORDER, SUPPLIER, 50_000, uint64(block.timestamp + 30 days));
        _expectNext(OrderExists.selector);
        _approveOrder(ORDER, SUPPLIER, 50_000, uint64(block.timestamp + 30 days));
    }

    function test_RefusesAZeroAmountOrAPastExpiry() public {
        _expectNext(InvalidOrder.selector);
        _approveOrder(ORDER, SUPPLIER, 0, uint64(block.timestamp + 30 days));
        _expectNext(InvalidOrder.selector);
        _approveOrder(ORDER, SUPPLIER, 50_000, uint64(block.timestamp));
    }

    function test_RefusesMoreThanTheAccountHolds() public {
        _expectNext(InsufficientBalance.selector);
        _approveOrder(ORDER, SUPPLIER, FUNDS + 1, uint64(block.timestamp + 30 days));
    }

    function test_ClosingAnOrderReturnsWhatIsLeftToTheAccount() public {
        OrderVault vault = _approveOrder(ORDER, SUPPLIER, 50_000, uint64(block.timestamp + 30 days));
        assertEq(_closeOrder(ORDER), 50_000);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(account)), FUNDS);
        assertTrue(vault.closed());
    }

    function test_ClosingAnUnknownOrderIsRefused() public {
        _expectNext(UnknownOrder.selector);
        _closeOrder(ORDER);
    }

    function test_ClosingTwiceIsRefused() public {
        _approveOrder(ORDER, SUPPLIER, 50_000, uint64(block.timestamp + 30 days));
        _closeOrder(ORDER);
        _expectNext(VaultClosed.selector);
        _closeOrder(ORDER);
    }
}

contract PauseAndWithdrawTest is Base {
    function test_PauseAndUnpause() public {
        vm.expectEmit(address(account));
        emit CountersignAccount.Paused();
        _pause();
        assertTrue(account.paused());
        vm.expectEmit(address(account));
        emit CountersignAccount.Unpaused();
        _unpause();
        assertFalse(account.paused());
    }

    function test_PausingTwiceOrUnpausingWhileRunningIsRefused() public {
        _expectNext(NotPaused.selector);
        _unpause();
        _pause();
        _expectNext(AlreadyPaused.selector);
        _pause();
    }

    function test_WithdrawSendsUnallocatedMoneyToTheSignedAddress() public {
        address treasury = makeAddr("company treasury");
        vm.expectEmit(address(account));
        emit CountersignAccount.Withdrawn(treasury, 400_000);
        _withdraw(treasury, 400_000);
        assertEq(usdc.balanceOf(treasury), 400_000);
    }

    function test_WithdrawWorksWhilePaused() public {
        _pause();
        _withdraw(makeAddr("company treasury"), FUNDS);
        assertEq(usdc.balanceOf(address(account)), 0);
    }

    function test_WithdrawRefusesTheZeroAddressAndMoreThanTheBalance() public {
        _expectNext(InvalidPayTo.selector);
        _withdraw(address(0), 1);
        _expectNext(InsufficientBalance.selector);
        _withdraw(makeAddr("company treasury"), FUNDS + 1);
    }
}
