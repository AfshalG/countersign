// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "@openzeppelin-contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {OwnerSig} from "../../src/CountersignTypes.sol";

/// @notice Produces WebAuthn assertions in tests from a software P-256 key, the way a
/// phone's passkey does in Slice 1: the challenge is the 32-byte EIP-712 digest, the
/// authenticator signs sha256(authenticatorData || sha256(clientDataJSON)).
library PasskeySigner {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// P-256 group order and half of it: OpenZeppelin's P256.verify refuses s above half.
    uint256 internal constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 internal constant HALF_N = N / 2;

    bytes1 internal constant FLAGS_UP_UV = 0x05; // user present, user verified (Face ID, fingerprint, PIN)
    bytes1 internal constant FLAGS_UP_ONLY = 0x01; // a tap without verification

    function publicKey(uint256 privateKey) internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = vm.publicKeyP256(privateKey);
        return (bytes32(x), bytes32(y));
    }

    /// One assertion as owner 0's signature: how a single-owner account takes it (D36).
    function only(WebAuthn.WebAuthnAuth memory auth) internal pure returns (OwnerSig[] memory s) {
        s = new OwnerSig[](1);
        s[0] = OwnerSig({owner: 0, auth: auth});
    }

    /// Signs as owner 0 of a single-owner account.
    function one(uint256 privateKey, bytes32 digest) internal pure returns (OwnerSig[] memory) {
        return only(sign(privateKey, digest));
    }

    /// A normal assertion: user verified, low-s.
    function sign(uint256 privateKey, bytes32 digest) internal pure returns (WebAuthn.WebAuthnAuth memory) {
        return assertion(privateKey, digest, FLAGS_UP_UV, "webauthn.get", false);
    }

    /// Any variation the tests need: flags, the ceremony type, or a high-s signature.
    function assertion(uint256 privateKey, bytes32 digest, bytes1 flags, string memory ceremony, bool highS)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        string memory clientDataJSON = string.concat(
            '{"type":"',
            ceremony,
            '","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"https://countersign.test","crossOrigin":false}'
        );
        bytes memory authenticatorData = abi.encodePacked(sha256("countersign.test"), flags, uint32(1));
        bytes32 message = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(privateKey, message);
        uint256 sv = uint256(s);
        if (sv > HALF_N) sv = N - sv;
        if (highS) sv = N - sv;
        auth.r = r;
        auth.s = bytes32(sv);
        auth.authenticatorData = authenticatorData;
        auth.clientDataJSON = clientDataJSON;
        auth.typeIndex = 1; // '{' then '"type":"…"'
        auth.challengeIndex = 1 + bytes(string.concat('"type":"', ceremony, '",')).length;
    }
}
