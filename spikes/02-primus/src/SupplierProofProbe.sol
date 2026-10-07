// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "@openzeppelin-contracts/utils/Strings.sol";
import {IPrimusZKTLS, Attestation} from "primus/IPrimusZKTLS.sol";

/// @title SupplierProofProbe (Spike 2, throwaway)
/// @notice Checks a Primus proof that a supplier's own website lists a payment address.
/// @dev Primus's verifier checks only the attestor's signature. Everything else is ours:
///  - Its hash packs string fields back to back with no separators, so bytes can move
///    between neighbouring fields (url into header, data into conditions) without
///    breaking the signature. Every field is therefore pinned exactly.
///  - It does not check the timestamp, although its comments say it does. We do.
///  - The `attestors` list in an attestation is not signed. It is never trusted;
///    only the verifier's own attestor list counts.
contract SupplierProofProbe {
    error WrongUrl();
    error WrongRequest();
    error WrongFields();
    error AddressDiffers();
    error ProofTooOld(uint256 ageSeconds);
    error ProofFromFuture();

    event SupplierProofChecked(address indexed payTo, bytes32 indexed urlHash, bool ok, bytes4 reason, uint256 gasUsed);

    /// Clock difference allowed between Primus's attestor and the chain.
    uint256 public constant MAX_CLOCK_SKEW = 300;

    bytes32 private constant GET = keccak256("GET");
    bytes32 private constant KEY_NAME = keccak256("payTo");
    bytes32 private constant PARSE_PATH = keccak256("$.payTo");
    bytes32 private constant CONDITIONS = keccak256('[{"op":"REVEAL_STRING","field":"$.payTo","reveal_id":"payTo"}]');
    bytes32 private constant ADDITION_PARAMS = keccak256('{"algorithmType":"proxytls"}');

    IPrimusZKTLS public immutable verifier;
    uint256 public immutable maxAge;

    /// Number of recorded checks, so `record` is a real state change in a block.
    uint256 public count;

    constructor(IPrimusZKTLS verifier_, uint256 maxAge_) {
        verifier = verifier_;
        maxAge = maxAge_;
    }

    /// @notice Reverts unless `att` is Primus's proof that `url` returned `{"payTo":"<payTo>"}` recently.
    function verify(Attestation calldata att, string calldata url, address payTo) public view returns (bool) {
        if (keccak256(bytes(att.request.url)) != keccak256(bytes(url))) revert WrongUrl();
        if (
            keccak256(bytes(att.request.method)) != GET || bytes(att.request.header).length != 0
                || bytes(att.request.body).length != 0
        ) revert WrongRequest();
        if (
            att.reponseResolve.length != 1 || keccak256(bytes(att.reponseResolve[0].keyName)) != KEY_NAME
                || bytes(att.reponseResolve[0].parseType).length != 0
                || keccak256(bytes(att.reponseResolve[0].parsePath)) != PARSE_PATH
                || keccak256(bytes(att.attConditions)) != CONDITIONS
                || keccak256(bytes(att.additionParams)) != ADDITION_PARAMS
        ) revert WrongFields();

        // The file publishes the checksummed address; Primus attests it verbatim.
        string memory expected = string.concat('{"payTo":"', Strings.toChecksumHexString(payTo), '"}');
        if (keccak256(bytes(att.data)) != keccak256(bytes(expected))) revert AddressDiffers();

        uint256 signedAt = att.timestamp / 1000; // Primus timestamps are in milliseconds
        if (signedAt > block.timestamp + MAX_CLOCK_SKEW) revert ProofFromFuture();
        if (block.timestamp > signedAt + maxAge) revert ProofTooOld(block.timestamp - signedAt);

        verifier.verifyAttestation(att); // reverts unless signed by an attestor the verifier trusts
        return true;
    }

    /// @notice Runs the check inside a transaction and records the outcome, success or not.
    function record(Attestation calldata att, string calldata url, address payTo) external returns (bool ok) {
        uint256 start = gasleft();
        bytes4 reason;
        try this.verify(att, url, payTo) returns (bool result) {
            ok = result;
        } catch (bytes memory err) {
            if (err.length >= 4) reason = bytes4(err);
        }
        count += 1;
        emit SupplierProofChecked(payTo, keccak256(bytes(url)), ok, reason, start - gasleft());
    }
}
