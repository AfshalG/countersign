// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {P256} from "@openzeppelin-contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";

/// @title PasskeyProbe (Spike 1, throwaway)
/// @notice Checks a passkey (WebAuthn) signature three ways so a testnet run shows
/// whether Monad's P256 precompile at 0x0100 did the work. The public key is an
/// argument, so one deployment serves every phone and laptop in the test.
/// @dev OpenZeppelin's P256.verify silently falls back to Solidity when the
/// precompile is missing, so passing `verify` alone proves nothing about Monad.
/// `verifyNative` reverts if the precompile is absent; `verifySolidity` never uses it.
contract PasskeyProbe {
    enum Mode {
        Full, // OpenZeppelin's WebAuthn.verify, user verification required: what the product will use
        Native, // signature step only, precompile required
        Solidity // signature step only, pure Solidity
    }

    event Verified(address indexed sender, bytes32 indexed qx, Mode mode, bool ok, uint256 gasUsed);

    /// Number of recorded checks. Exists so `record` is a real state change in a block.
    uint256 public count;

    function verify(bytes calldata challenge, WebAuthn.WebAuthnAuth calldata auth, bytes32 qx, bytes32 qy)
        public
        view
        returns (bool)
    {
        // requireUV: Face ID, a fingerprint or a PIN, not just a tap.
        return WebAuthn.verify(challenge, auth, qx, qy, true);
    }

    function verifyNative(bytes calldata, WebAuthn.WebAuthnAuth calldata auth, bytes32 qx, bytes32 qy)
        public
        view
        returns (bool)
    {
        return P256.verifyNative(_digest(auth), auth.r, auth.s, qx, qy);
    }

    function verifySolidity(bytes calldata, WebAuthn.WebAuthnAuth calldata auth, bytes32 qx, bytes32 qy)
        public
        view
        returns (bool)
    {
        return P256.verifySolidity(_digest(auth), auth.r, auth.s, qx, qy);
    }

    /// @notice Runs one check inside a transaction and records the result and its gas.
    function record(bytes calldata challenge, WebAuthn.WebAuthnAuth calldata auth, bytes32 qx, bytes32 qy, Mode mode)
        external
        returns (bool ok)
    {
        uint256 start = gasleft();
        if (mode == Mode.Full) ok = verify(challenge, auth, qx, qy);
        else if (mode == Mode.Native) ok = verifyNative(challenge, auth, qx, qy);
        else ok = verifySolidity(challenge, auth, qx, qy);
        uint256 used = start - gasleft();
        count += 1;
        emit Verified(msg.sender, qx, mode, ok, used);
    }

    /// The message a WebAuthn authenticator signs: sha256(authenticatorData || sha256(clientDataJSON)).
    function _digest(WebAuthn.WebAuthnAuth calldata auth) private pure returns (bytes32) {
        return sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
    }
}
