// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Base} from "../helpers/Base.sol";
import {PasskeySigner} from "../helpers/PasskeySigner.sol";
import {OrderVault} from "../../src/OrderVault.sol";
import {OwnerAuth} from "../../src/libraries/OwnerAuth.sol";
import {OwnerKey, OwnerSig, Payment, Decision} from "../../src/CountersignTypes.sol";
import "../../src/CountersignErrors.sol";

/// @notice Several approvers (D36): an account's owners and its two thresholds. Adding a
/// supplier, opening an order, setting the policy, changing the owners and unpausing need the
/// manage threshold; paying a held payment once needs the release threshold; pausing and
/// refusing need one owner, because stopping money must never wait for a second person.
contract OwnersTest is Base {
    uint256 internal constant SECOND_PK = 0x5a17c3e9d2b8f4016e7a3c9d5b1f8e2a6c4d0b9f7e3a1c5d8b2f6e4a0c9d7b31;
    uint256 internal constant STRANGER_PK = 0x1f2e3d4c5b6a79880f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978;

    function setUp() public override {
        super.setUp();
        _setPolicy(defaultPolicy());
    }

    // ---------- helpers ----------

    function _key(uint256 pk) internal pure returns (OwnerKey memory k) {
        (k.qx, k.qy) = PasskeySigner.publicKey(pk);
    }

    /// Signatures over `digest` by the given owners (index, key), in the order given.
    function _sigs(bytes32 digest, uint8[] memory owners, uint256[] memory pks)
        internal
        pure
        returns (OwnerSig[] memory s)
    {
        s = new OwnerSig[](owners.length);
        for (uint256 i = 0; i < owners.length; i++) {
            s[i] = OwnerSig({owner: owners[i], auth: PasskeySigner.sign(pks[i], digest)});
        }
    }

    function _one(uint8 a, uint256 pa) internal pure returns (uint8[] memory o, uint256[] memory p) {
        o = new uint8[](1);
        p = new uint256[](1);
        (o[0], p[0]) = (a, pa);
    }

    function _two(uint8 a, uint256 pa, uint8 b, uint256 pb)
        internal
        pure
        returns (uint8[] memory o, uint256[] memory p)
    {
        o = new uint8[](2);
        p = new uint256[](2);
        (o[0], p[0], o[1], p[1]) = (a, pa, b, pb);
    }

    /// The account's owners become [the original, SECOND], with these thresholds.
    function _addSecondOwner(uint8 manage, uint8 release) internal {
        OwnerKey[] memory keys = new OwnerKey[](2);
        keys[0] = _key(OWNER_PK);
        keys[1] = _key(SECOND_PK);
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        account.setOwners(
            keys, manage, release, n, dl, _ownerSign(OwnerAuth.setOwnersHash(keys, manage, release, n, dl))
        );
    }

    function _setSupplierBy(uint8[] memory owners, uint256[] memory pks) internal {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        bytes32 digest = account.ownerDigest(OwnerAuth.setSupplierHash(SUPPLIER, supplierAddr, true, 0, n, dl));
        account.setSupplier(SUPPLIER, supplierAddr, true, 0, n, dl, _sigs(digest, owners, pks));
    }

    // ---------- owners and thresholds ----------

    function test_ANewAccountHasOneOwnerAndThresholdsOfOne() public view {
        OwnerKey[] memory owners = account.owners();
        assertEq(owners.length, 1);
        assertEq(owners[0].qx, qx);
        assertEq(owners[0].qy, qy);
        assertEq(account.manageThreshold(), 1);
        assertEq(account.releaseThreshold(), 1);
    }

    function test_TheOwnerAddsASecondOwnerAndRequiresTwoToManage() public {
        _addSecondOwner(2, 1);
        assertEq(account.owners().length, 2);
        assertEq(account.owners()[1].qx, _key(SECOND_PK).qx);
        assertEq(account.manageThreshold(), 2);
        assertEq(account.releaseThreshold(), 1);
    }

    function test_WithTwoRequiredOneOwnerCannotAddASupplier() public {
        _addSecondOwner(2, 1);
        (uint8[] memory o, uint256[] memory p) = _one(0, OWNER_PK);
        vm.expectRevert(NotEnoughSigners.selector);
        this.setSupplierBy(o, p);
    }

    function test_TwoOwnersAddASupplierTogether() public {
        _addSecondOwner(2, 1);
        (uint8[] memory o, uint256[] memory p) = _two(0, OWNER_PK, 1, SECOND_PK);
        _setSupplierBy(o, p);
        assertEq(account.supplier(SUPPLIER).payTo, supplierAddr);
    }

    function test_OneOwnerCannotCountTwice() public {
        _addSecondOwner(2, 1);
        (uint8[] memory o, uint256[] memory p) = _two(0, OWNER_PK, 0, OWNER_PK);
        vm.expectRevert(OwnersOutOfOrder.selector);
        this.setSupplierBy(o, p);
    }

    function test_OwnersMustSignInOrder() public {
        _addSecondOwner(2, 1);
        (uint8[] memory o, uint256[] memory p) = _two(1, SECOND_PK, 0, OWNER_PK);
        vm.expectRevert(OwnersOutOfOrder.selector);
        this.setSupplierBy(o, p);
    }

    function test_AnUnknownOwnerIsRefused() public {
        (uint8[] memory o, uint256[] memory p) = _one(3, OWNER_PK);
        vm.expectRevert(UnknownOwner.selector);
        this.setSupplierBy(o, p);
    }

    function test_AStrangersPasskeyInAnOwnersPlaceIsRefused() public {
        _addSecondOwner(2, 1);
        (uint8[] memory o, uint256[] memory p) = _two(0, OWNER_PK, 1, STRANGER_PK);
        vm.expectRevert(InvalidOwnerSignature.selector);
        this.setSupplierBy(o, p);
    }

    function test_AnyOneOwnerCanPause() public {
        _addSecondOwner(2, 2);
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        (uint8[] memory o, uint256[] memory p) = _one(1, SECOND_PK);
        account.pause(n, dl, _sigs(account.ownerDigest(OwnerAuth.pauseHash(n, dl)), o, p));
        assertTrue(account.paused());
    }

    function test_UnpausingNeedsTheManageThreshold() public {
        _addSecondOwner(2, 1);
        _pauseBy(0, OWNER_PK);
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        bytes32 digest = account.ownerDigest(OwnerAuth.unpauseHash(n, dl));
        (uint8[] memory o1, uint256[] memory p1) = _one(0, OWNER_PK);
        OwnerSig[] memory one = _sigs(digest, o1, p1);
        vm.expectRevert(NotEnoughSigners.selector);
        account.unpause(n, dl, one);
        (uint8[] memory o2, uint256[] memory p2) = _two(0, OWNER_PK, 1, SECOND_PK);
        account.unpause(n, dl, _sigs(digest, o2, p2));
        assertFalse(account.paused());
    }

    function _pauseBy(uint8 owner, uint256 pk) internal {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        (uint8[] memory o, uint256[] memory p) = _one(owner, pk);
        account.pause(n, dl, _sigs(account.ownerDigest(OwnerAuth.pauseHash(n, dl)), o, p));
    }

    // ---------- the vault: pay once, refuse ----------

    function _heldVault() internal returns (OrderVault vault, Payment memory pay) {
        _setSupplier(SUPPLIER, supplierAddr, true);
        vm.warp(vm.getBlockTimestamp() + WAIT + 1);
        vault = _approveOrder(ORDER, SUPPLIER, 50_000, uint64(vm.getBlockTimestamp() + 30 days));
        pay = Payment({
            amount: 1_000,
            invoiceHash: keccak256("INV-0042"),
            payTo: supplierAddr,
            deadline: uint64(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function test_PayingOnceNeedsTheReleaseThreshold() public {
        (OrderVault vault, Payment memory pay) = _heldVault();
        _addSecondOwner(2, 2);
        bytes32 digest = vault.paymentDigest(pay);
        (uint8[] memory o1, uint256[] memory p1) = _one(0, OWNER_PK);
        OwnerSig[] memory one = _sigs(digest, o1, p1);
        vm.expectRevert(NotEnoughSigners.selector);
        vault.payWithOwner(pay, one);
        (uint8[] memory o2, uint256[] memory p2) = _two(0, OWNER_PK, 1, SECOND_PK);
        vault.payWithOwner(pay, _sigs(digest, o2, p2));
        assertEq(usdc.balanceOf(supplierAddr), 1_000);
    }

    function test_AnyOneOwnerCanRefuseAHold() public {
        (OrderVault vault,) = _heldVault();
        _addSecondOwner(2, 2);
        Decision memory d = Decision({
            invoiceHash: keccak256("INV-0042"), outcome: 2, reasonHash: keccak256("refused"), evidenceHash: 0
        });
        (uint8[] memory o, uint256[] memory p) = _one(1, SECOND_PK);
        vault.recordDecisionByOwner(d, _sigs(vault.decisionDigest(d), o, p));
    }

    // ---------- changing the owners ----------

    function test_SetOwnersRefusesSetsThatCannotWork() public {
        OwnerKey[] memory none = new OwnerKey[](0);
        _expectSetOwners(none, 1, 1, InvalidOwners.selector);
        OwnerKey[] memory six = new OwnerKey[](6);
        for (uint256 i = 0; i < 6; i++) {
            six[i] = _key(uint256(keccak256(abi.encode("owner", i))) % (PasskeySigner.N - 1) + 1);
        }
        _expectSetOwners(six, 1, 1, InvalidOwners.selector);
        OwnerKey[] memory twice = new OwnerKey[](2);
        (twice[0], twice[1]) = (_key(OWNER_PK), _key(OWNER_PK));
        _expectSetOwners(twice, 1, 1, InvalidOwners.selector);
        OwnerKey[] memory offCurve = new OwnerKey[](1);
        offCurve[0] = OwnerKey({qx: bytes32(uint256(1)), qy: bytes32(uint256(2))});
        _expectSetOwners(offCurve, 1, 1, InvalidOwnerKey.selector);
        OwnerKey[] memory two = new OwnerKey[](2);
        (two[0], two[1]) = (_key(OWNER_PK), _key(SECOND_PK));
        _expectSetOwners(two, 0, 1, InvalidOwners.selector);
        _expectSetOwners(two, 1, 3, InvalidOwners.selector);
    }

    function _expectSetOwners(OwnerKey[] memory keys, uint8 manage, uint8 release, bytes4 err) internal {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        OwnerSig[] memory s = _ownerSign(OwnerAuth.setOwnersHash(keys, manage, release, n, dl));
        vm.expectRevert(err);
        account.setOwners(keys, manage, release, n, dl, s);
    }

    function test_ARemovedOwnersPasskeyStopsWorking() public {
        _addSecondOwner(2, 1);
        OwnerKey[] memory onlySecond = new OwnerKey[](1);
        onlySecond[0] = _key(SECOND_PK);
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        bytes32 digest = account.ownerDigest(OwnerAuth.setOwnersHash(onlySecond, 1, 1, n, dl));
        (uint8[] memory o, uint256[] memory p) = _two(0, OWNER_PK, 1, SECOND_PK);
        account.setOwners(onlySecond, 1, 1, n, dl, _sigs(digest, o, p));
        // Owner 0 is now the second passkey: the first one signs nothing any more.
        n = account.ownerNonce();
        (uint8[] memory o1, uint256[] memory p1) = _one(0, OWNER_PK);
        OwnerSig[] memory old = _sigs(account.ownerDigest(OwnerAuth.pauseHash(n, dl)), o1, p1);
        vm.expectRevert(InvalidOwnerSignature.selector);
        account.pause(n, dl, old);
    }

    // External, so vm.expectRevert can wrap the whole call.
    function setSupplierBy(uint8[] memory owners, uint256[] memory pks) external {
        _setSupplierBy(owners, pks);
    }
}
