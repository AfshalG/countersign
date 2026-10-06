// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {PasskeyProbe} from "../src/PasskeyProbe.sol";

contract PasskeyProbeTest is Test {
    PasskeyProbe probe;
    string json;
    bytes32 qx;
    bytes32 qy;
    bytes challenge;

    function setUp() public {
        probe = new PasskeyProbe();
        json = vm.readFile("test/fixtures/vectors.json");
        qx = vm.parseJsonBytes32(json, ".qx");
        qy = vm.parseJsonBytes32(json, ".qy");
        challenge = vm.parseJsonBytes(json, ".challenge");
    }

    function auth(string memory key) internal view returns (WebAuthn.WebAuthnAuth memory a) {
        string memory p = string.concat(".", key, ".");
        a.r = vm.parseJsonBytes32(json, string.concat(p, "r"));
        a.s = vm.parseJsonBytes32(json, string.concat(p, "s"));
        a.challengeIndex = vm.parseJsonUint(json, string.concat(p, "challengeIndex"));
        a.typeIndex = vm.parseJsonUint(json, string.concat(p, "typeIndex"));
        a.authenticatorData = vm.parseJsonBytes(json, string.concat(p, "authenticatorData"));
        a.clientDataJSON = vm.parseJsonString(json, string.concat(p, "clientDataJSON"));
    }

    function test_ValidSignaturePasses() public view {
        assertTrue(probe.verify(challenge, auth("valid"), qx, qy));
    }

    function test_ValidSignaturePassesThroughThePrecompile() public view {
        // Reverts with MissingPrecompile if 0x0100 is absent, so this proves the native path.
        assertTrue(probe.verifyNative(challenge, auth("valid"), qx, qy));
    }

    function test_ValidSignaturePassesInSolidity() public view {
        assertTrue(probe.verifySolidity(challenge, auth("valid"), qx, qy));
    }

    function test_WrongChallengeFails() public view {
        bytes memory other = abi.encodePacked(keccak256("another payment"));
        assertFalse(probe.verify(other, auth("valid"), qx, qy));
    }

    function test_RegistrationTypeFails() public view {
        assertFalse(probe.verify(challenge, auth("createType"), qx, qy));
    }

    function test_MissingUserVerificationFails() public view {
        assertFalse(probe.verify(challenge, auth("noUV"), qx, qy));
    }

    function test_HighSFails() public view {
        assertFalse(probe.verify(challenge, auth("highS"), qx, qy));
    }

    function test_OtherKeyFails() public view {
        bytes32 ox_ = vm.parseJsonBytes32(json, ".otherQx");
        bytes32 oy = vm.parseJsonBytes32(json, ".otherQy");
        assertFalse(probe.verify(challenge, auth("valid"), ox_, oy));
    }

    function testFuzz_RandomChallengeFails(bytes32 random) public view {
        vm.assume(random != bytes32(challenge));
        assertFalse(probe.verify(abi.encodePacked(random), auth("valid"), qx, qy));
    }

    function test_RecordEmitsResultAndCounts() public {
        vm.expectEmit(true, true, false, false);
        emit PasskeyProbe.Verified(address(this), qx, PasskeyProbe.Mode.Full, true, 0);
        assertTrue(probe.record(challenge, auth("valid"), qx, qy, PasskeyProbe.Mode.Full));
        assertEq(probe.count(), 1);
    }

    function test_RecordedFailureIsStillRecorded() public {
        assertFalse(probe.record(challenge, auth("noUV"), qx, qy, PasskeyProbe.Mode.Full));
        assertEq(probe.count(), 1);
    }

    function test_PrecompileIsCheaperThanSolidity() public {
        WebAuthn.WebAuthnAuth memory a = auth("valid");
        uint256 g = gasleft();
        probe.verifyNative(challenge, a, qx, qy);
        uint256 nativeGas = g - gasleft();
        g = gasleft();
        probe.verifySolidity(challenge, a, qx, qy);
        uint256 solidityGas = g - gasleft();
        emit log_named_uint("signature check, precompile (gas)", nativeGas);
        emit log_named_uint("signature check, Solidity (gas)", solidityGas);
        assertLt(nativeGas, solidityGas);
    }
}
