// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "@openzeppelin-contracts/utils/Strings.sol";
import {IPrimusZKTLS, Attestation} from "primus/IPrimusZKTLS.sol";

/// @title SupplierProofs (Slice 15)
/// @notice Records what a supplier's own website lists as its payment address, proven by a Primus
/// zkTLS proof of `https://<site>/.well-known/countersign.json` ({"payTo":"0x…"}). An owner's
/// `setSupplier` signs the proof hash it was approved on, so the supplier record on chain names its
/// evidence. Every genuine proof is recorded, whether or not it lists the address someone hoped
/// for: "the site lists another address" is a fact worth proving too. Anyone may record one.
/// @dev Spike 2's findings, all handled here:
///  - Primus's verifier checks only the attestor's signature, not the time; we check the time.
///  - Its hash packs strings back to back with no separators, so bytes can move between
///    neighbouring fields without breaking the signature: every field is pinned exactly.
///  - The `attestors` list in a proof is not signed; only the verifier's own list counts.
///  - Signatures are malleable, so a proof's id is built from its content, never its signature.
contract SupplierProofs {
    error NotAnAddressFile();
    error WrongRequest();
    error WrongFields();
    error NotAnAddress();
    error ProofTooOld(uint256 ageSeconds);
    error ProofFromFuture();

    struct Proof {
        address listed; // the address the website's file listed
        uint64 signedAt; // when Primus signed the proof, in seconds
        bytes32 urlHash; // keccak256 of the file's URL
    }

    event SupplierProofRecorded(
        bytes32 indexed proofHash, bytes32 indexed urlHash, address indexed listed, uint64 signedAt, string url
    );

    /// A proof is recorded only this soon after Primus signed it.
    uint256 public constant MAX_AGE = 1 hours;
    /// Clock difference allowed between Primus's attestor and the chain.
    uint256 public constant MAX_CLOCK_SKEW = 300;

    bytes private constant HTTPS = "https://";
    bytes private constant FILE = "/.well-known/countersign.json";
    bytes private constant DATA_HEAD = '{"payTo":"';
    bytes private constant DATA_TAIL = '"}';
    bytes32 private constant GET = keccak256("GET");
    bytes32 private constant KEY_NAME = keccak256("payTo");
    bytes32 private constant PARSE_PATH = keccak256("$.payTo");
    bytes32 private constant CONDITIONS = keccak256('[{"op":"REVEAL_STRING","field":"$.payTo","reveal_id":"payTo"}]');
    bytes32 private constant ADDITION_PARAMS = keccak256('{"algorithmType":"proxytls"}');

    IPrimusZKTLS public immutable verifier;

    mapping(bytes32 proofHash => Proof) public proofs;
    /// The most recently signed proof recorded for each file URL.
    mapping(bytes32 urlHash => bytes32 proofHash) public latest;

    constructor(IPrimusZKTLS verifier_) {
        verifier = verifier_;
    }

    /// @notice Checks a Primus proof of a supplier's address file and records what it lists.
    /// Recording the same proof again changes nothing and returns the same hash.
    function record(Attestation calldata att) external returns (bytes32 proofHash) {
        bytes calldata url = bytes(att.request.url);
        if (!_isAddressFile(url)) revert NotAnAddressFile();
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
        address listed = _listed(bytes(att.data));

        uint64 signedAt = att.timestamp / 1000; // Primus timestamps are in milliseconds
        if (signedAt > block.timestamp + MAX_CLOCK_SKEW) revert ProofFromFuture();
        if (block.timestamp > signedAt + MAX_AGE) revert ProofTooOld(block.timestamp - signedAt);

        verifier.verifyAttestation(att); // reverts unless signed by an attestor the verifier trusts

        bytes32 urlHash = keccak256(url);
        proofHash = keccak256(abi.encode(urlHash, listed, signedAt));
        if (proofs[proofHash].signedAt != 0) return proofHash;
        proofs[proofHash] = Proof({listed: listed, signedAt: signedAt, urlHash: urlHash});
        if (signedAt > proofs[latest[urlHash]].signedAt) latest[urlHash] = proofHash;
        emit SupplierProofRecorded(proofHash, urlHash, listed, signedAt, att.request.url);
    }

    /// @notice True if the recorded proof shows the website listing `payTo`.
    function lists(bytes32 proofHash, address payTo) external view returns (bool) {
        Proof memory p = proofs[proofHash];
        return p.signedAt != 0 && p.listed == payTo;
    }

    /// `https://<host>/.well-known/countersign.json`, the host with no path, query, port-less
    /// credentials or fragment: the site's own file and nothing else.
    function _isAddressFile(bytes calldata url) private pure returns (bool) {
        uint256 head = HTTPS.length;
        uint256 tail = FILE.length;
        if (url.length <= head + tail) return false;
        if (keccak256(url[:head]) != keccak256(HTTPS)) return false;
        if (keccak256(url[url.length - tail:]) != keccak256(FILE)) return false;
        for (uint256 i = head; i < url.length - tail; i++) {
            bytes1 c = url[i];
            if (c == "/" || c == "?" || c == "#" || c == "@" || c == "\\") return false;
        }
        return true;
    }

    /// The address in `{"payTo":"0x…"}` exactly (Primus's JSON of the one revealed value), in
    /// either letter case: addresses are compared as bytes, not as text.
    function _listed(bytes calldata data) private pure returns (address) {
        uint256 head = DATA_HEAD.length;
        if (data.length != head + 42 + DATA_TAIL.length) revert NotAnAddress();
        if (keccak256(data[:head]) != keccak256(DATA_HEAD)) revert NotAnAddress();
        if (keccak256(data[head + 42:]) != keccak256(DATA_TAIL)) revert NotAnAddress();
        (bool ok, address listed) = Strings.tryParseAddress(string(data[head:head + 42]));
        if (!ok) revert NotAnAddress();
        return listed;
    }
}
