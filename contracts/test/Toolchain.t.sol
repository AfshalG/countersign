// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {P256} from "@openzeppelin-contracts/utils/cryptography/P256.sol";

/// Proves the toolchain end to end: Soldeer installed OpenZeppelin, the
/// remappings resolve, and fuzzing runs. The owner passkey in Slice 1 is
/// checked with this same library.
contract ToolchainTest is Test {
    // The P-256 generator point: a public key known to be on the curve.
    bytes32 constant QX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296;
    bytes32 constant QY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5;

    function test_GeneratorIsAValidPublicKey() public pure {
        assertTrue(P256.isValidPublicKey(QX, QY));
    }

    function testFuzz_RandomSignatureDoesNotVerify(bytes32 hash, bytes32 r, bytes32 s) public view {
        // A zero hash is excluded on purpose: with h = 0, r = s = Qx is a valid ECDSA
        // signature for any key Q (u1 = 0, u2 = 1, so R = Q). CI's fuzzer found it.
        // Product code never passes a caller-chosen hash; WebAuthn.verify always hashes.
        vm.assume(hash != bytes32(0));
        assertFalse(P256.verify(hash, r, s, QX, QY));
    }

    function test_ZeroHashIsForgeableForAnyKey() public view {
        // Documents the property above, so nobody relies on P256.verify with a raw hash.
        assertTrue(P256.verify(bytes32(0), QX, QX, QX, QY));
    }
}
