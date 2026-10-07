// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {PrimusZKTLS} from "primus/PrimusZKTLS.sol";
import {IPrimusZKTLS, Attestation, Attestor} from "primus/IPrimusZKTLS.sol";
import {SupplierProofProbe} from "../src/SupplierProofProbe.sol";

contract SupplierProofProbeTest is Test {
    address constant PRIMUS_ATTESTOR = 0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6;
    string constant URL = "https://countersign-supplier-demo.vercel.app/.well-known/countersign.json";
    address constant PAY_TO = 0x90f9931B748B26763161a8191C178Fe425C25fEc;
    uint256 constant MAX_AGE = 24 hours;

    IPrimusZKTLS verifier; // trusts Primus's attestor, deployed the way Primus deploys it
    SupplierProofProbe probe;

    // A second verifier trusting a test key, so attestations with valid signatures but
    // wrong fields can be made to exercise the probe's own checks.
    address testSigner;
    uint256 testKey;
    IPrimusZKTLS testVerifier;
    SupplierProofProbe testProbe;

    Attestation real;

    function deployVerifier(address attestor) internal returns (IPrimusZKTLS) {
        Attestor[] memory attestors = new Attestor[](1);
        attestors[0] = Attestor({attestorAddr: attestor, url: "https://primuslabs.xyz"});
        PrimusZKTLS logic = new PrimusZKTLS();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(logic), address(this), abi.encodeCall(PrimusZKTLS.initialize, (address(this), attestors))
        );
        return IPrimusZKTLS(address(proxy));
    }

    function setUp() public {
        verifier = deployVerifier(PRIMUS_ATTESTOR);
        probe = new SupplierProofProbe(verifier, MAX_AGE);
        (testSigner, testKey) = makeAddrAndKey("test attestor");
        testVerifier = deployVerifier(testSigner);
        testProbe = new SupplierProofProbe(testVerifier, MAX_AGE);

        bytes memory encoded = vm.parseBytes(vm.readFile("test/fixtures/attestation-supplier.abi"));
        real = abi.decode(encoded, (Attestation));
        vm.warp(real.timestamp / 1000 + 60); // a minute after Primus signed it
    }

    /// Signs an attestation with the test key, the way Primus signs (raw digest, no prefix).
    function signWithTestKey(Attestation memory att) internal view returns (Attestation memory) {
        bytes32 digest = PrimusZKTLS(address(testVerifier)).encodeAttestation(att);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(testKey, digest);
        att.signatures = new bytes[](1);
        att.signatures[0] = abi.encodePacked(r, s, v);
        return att;
    }

    // --- The real proof ---

    function test_RealProofPasses() public view {
        assertTrue(probe.verify(real, URL, PAY_TO));
    }

    function test_RealProofPassesPrimusVerifierDirectly() public view {
        verifier.verifyAttestation(real);
    }

    // --- Business rules ---

    function test_DifferentAddressFails() public {
        vm.expectRevert(SupplierProofProbe.AddressDiffers.selector);
        probe.verify(real, URL, makeAddr("look-alike"));
    }

    function test_LookAlikeDomainFails() public {
        vm.expectRevert(SupplierProofProbe.WrongUrl.selector);
        probe.verify(real, "https://countersign-supplier-demo.vercel.app.evil.com/.well-known/countersign.json", PAY_TO);
    }

    function test_OtherPathFails() public {
        vm.expectRevert(SupplierProofProbe.WrongUrl.selector);
        probe.verify(real, "https://countersign-supplier-demo.vercel.app/countersign.json", PAY_TO);
    }

    function test_TooOldFails() public {
        vm.warp(real.timestamp / 1000 + MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(SupplierProofProbe.ProofTooOld.selector, MAX_AGE + 1));
        probe.verify(real, URL, PAY_TO);
    }

    function test_FromTheFutureFails() public {
        vm.warp(real.timestamp / 1000 - 301);
        vm.expectRevert(SupplierProofProbe.ProofFromFuture.selector);
        probe.verify(real, URL, PAY_TO);
    }

    // --- Signatures ---

    function test_OneChangedCharacterFailsPrimusSignature() public {
        // Swap the attested address for another one and claim that one: the probe's own
        // checks pass, so only Primus's signature check stands in the way.
        address other = makeAddr("other supplier");
        Attestation memory att = real;
        att.data = string.concat('{"payTo":"', vm.toString(other), '"}');
        vm.expectRevert("Invalid signature");
        probe.verify(att, URL, other);
    }

    function test_SignedByAnotherKeyFails() public {
        Attestation memory att = signWithTestKey(real);
        vm.expectRevert("Invalid signature");
        probe.verify(att, URL, PAY_TO);
    }

    function test_EditedAttestorListIsIgnored() public {
        // The attestors list is not covered by Primus's signature; editing it must not help.
        Attestation memory att = signWithTestKey(real);
        att.attestors[0].attestorAddr = testSigner;
        vm.expectRevert("Invalid signature");
        probe.verify(att, URL, PAY_TO);
    }

    // --- Fields next to each other in Primus's packed hash are pinned ---

    function test_ShiftingUrlIntoHeaderKeepsPrimusSignatureButFails() public {
        // Primus hashes url and header back to back with no separator, so moving the last
        // character of the URL into the header leaves the real signature valid.
        Attestation memory att = real;
        att.request.url = "https://countersign-supplier-demo.vercel.app/.well-known/countersign.jso";
        att.request.header = "n";
        verifier.verifyAttestation(att); // Primus's verifier still accepts it
        // Even when the shortened URL is the one expected, the pinned (empty) header catches it.
        vm.expectRevert(SupplierProofProbe.WrongRequest.selector);
        probe.verify(att, "https://countersign-supplier-demo.vercel.app/.well-known/countersign.jso", PAY_TO);
    }

    function test_ShiftingDataIntoConditionsKeepsPrimusSignatureButFails() public {
        Attestation memory att = real;
        att.data = '{"payTo":"0x90f9931B748B26763161a8191C178Fe425C25fEc"';
        att.attConditions = string.concat("}", real.attConditions);
        verifier.verifyAttestation(att); // Primus's verifier still accepts it
        // The pinned conditions field catches it before the address check.
        vm.expectRevert(SupplierProofProbe.WrongFields.selector);
        probe.verify(att, URL, PAY_TO);
    }

    // --- Request shape, with valid signatures from the test key ---

    function test_PostRequestFails() public {
        Attestation memory att = real;
        att.request.method = "POST";
        att = signWithTestKey(att);
        vm.expectRevert(SupplierProofProbe.WrongRequest.selector);
        testProbe.verify(att, URL, PAY_TO);
    }

    function test_RequestWithBodyFails() public {
        Attestation memory att = real;
        att.request.body = "x";
        att = signWithTestKey(att);
        vm.expectRevert(SupplierProofProbe.WrongRequest.selector);
        testProbe.verify(att, URL, PAY_TO);
    }

    function test_OtherParsePathFails() public {
        Attestation memory att = real;
        att.reponseResolve[0].parsePath = "$.other";
        att = signWithTestKey(att);
        vm.expectRevert(SupplierProofProbe.WrongFields.selector);
        testProbe.verify(att, URL, PAY_TO);
    }

    function test_TestKeyProofWithRightFieldsPasses() public view {
        // Sanity: the probe logic accepts a correct proof from whichever attestor its verifier trusts.
        assertTrue(testProbe.verify(signWithTestKey(real), URL, PAY_TO));
    }

    // --- Fuzz ---

    function testFuzz_AnyOtherAddressFails(address other) public {
        vm.assume(other != PAY_TO);
        vm.expectRevert(SupplierProofProbe.AddressDiffers.selector);
        probe.verify(real, URL, other);
    }

    // --- Recording in a transaction ---

    function test_RecordEmitsResultAndCounts() public {
        assertTrue(probe.record(real, URL, PAY_TO));
        assertFalse(probe.record(real, URL, makeAddr("look-alike")));
        assertEq(probe.count(), 2);
    }

    function test_GasForTheCheck() public {
        uint256 g = gasleft();
        probe.verify(real, URL, PAY_TO);
        emit log_named_uint("supplier proof check (gas)", g - gasleft());
    }
}
