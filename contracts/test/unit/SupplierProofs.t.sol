// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {PrimusZKTLS} from "primus/PrimusZKTLS.sol";
import {IPrimusZKTLS, Attestation, Attestor} from "primus/IPrimusZKTLS.sol";
import {SupplierProofs} from "../../src/SupplierProofs.sol";

/// Slice 15: what a supplier's own website lists, proven by Primus and recorded on Monad. The two
/// recorded proofs are real (Spike 2, 7 Oct): the demo supplier's file listing its address, and the
/// same file changed to another address.
contract SupplierProofsTest is Test {
    address constant PRIMUS_ATTESTOR = 0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6;
    string constant URL = "https://countersign-supplier-demo.vercel.app/.well-known/countersign.json";
    address constant KALIBRE = 0x90f9931B748B26763161a8191C178Fe425C25fEc;
    address constant CHANGED = 0xc91f6a35D139E713eAF11D72C8b76B609fA11385;

    SupplierProofs proofs;
    // A second registry whose verifier trusts a test key: proofs with valid signatures but wrong
    // fields exercise the registry's own checks.
    SupplierProofs testProofs;
    IPrimusZKTLS testVerifier;
    address testSigner;
    uint256 testKey;

    Attestation real;
    Attestation changed;

    function deployVerifier(address attestor) internal returns (IPrimusZKTLS) {
        Attestor[] memory attestors = new Attestor[](1);
        attestors[0] = Attestor({attestorAddr: attestor, url: "https://primuslabs.xyz"});
        PrimusZKTLS logic = new PrimusZKTLS();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(logic), address(this), abi.encodeCall(PrimusZKTLS.initialize, (address(this), attestors))
        );
        return IPrimusZKTLS(address(proxy));
    }

    function load(string memory name) internal view returns (Attestation memory) {
        return abi.decode(vm.parseBytes(vm.readFile(string.concat("test/fixtures/", name))), (Attestation));
    }

    function setUp() public {
        proofs = new SupplierProofs(deployVerifier(PRIMUS_ATTESTOR));
        (testSigner, testKey) = makeAddrAndKey("test attestor");
        testVerifier = deployVerifier(testSigner);
        testProofs = new SupplierProofs(testVerifier);
        real = load("attestation-supplier.abi");
        changed = load("attestation-changed.abi");
        vm.warp(real.timestamp / 1000 + 60); // a minute after Primus signed it
    }

    function signWithTestKey(Attestation memory att) internal view returns (Attestation memory) {
        bytes32 digest = PrimusZKTLS(address(testVerifier)).encodeAttestation(att);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(testKey, digest);
        att.signatures = new bytes[](1);
        att.signatures[0] = abi.encodePacked(r, s, v);
        return att;
    }

    function withData(string memory data) internal view returns (Attestation memory att) {
        att = real;
        att.data = data;
        att = signWithTestKey(att);
    }

    // --- What gets recorded ---

    function test_RecordsWhatTheWebsiteLists() public {
        bytes32 expected = keccak256(abi.encode(keccak256(bytes(URL)), KALIBRE, uint64(real.timestamp / 1000)));
        vm.expectEmit(address(proofs));
        emit SupplierProofs.SupplierProofRecorded(
            expected, keccak256(bytes(URL)), KALIBRE, uint64(real.timestamp / 1000), URL
        );
        bytes32 proofHash = proofs.record(real);
        assertEq(proofHash, expected);
        (address listed, uint64 signedAt, bytes32 urlHash) = proofs.proofs(proofHash);
        assertEq(listed, KALIBRE);
        assertEq(signedAt, real.timestamp / 1000);
        assertEq(urlHash, keccak256(bytes(URL)));
        assertEq(proofs.latest(keccak256(bytes(URL))), proofHash);
        assertTrue(proofs.lists(proofHash, KALIBRE));
        assertFalse(proofs.lists(proofHash, CHANGED));
    }

    function test_RecordsAProofThatListsAnotherAddressToo() public {
        vm.warp(changed.timestamp / 1000 + 60);
        bytes32 proofHash = proofs.record(changed);
        assertTrue(proofs.lists(proofHash, CHANGED));
        assertFalse(proofs.lists(proofHash, KALIBRE));
    }

    function test_TheNewerProofIsTheLatest() public {
        bytes32 first = proofs.record(real);
        vm.warp(changed.timestamp / 1000 + 60);
        bytes32 second = proofs.record(changed);
        assertEq(proofs.latest(keccak256(bytes(URL))), second);
        // Recording the older one again changes nothing.
        assertEq(proofs.record(real), first);
        assertEq(proofs.latest(keccak256(bytes(URL))), second);
    }

    function test_RecordingTwiceIsOneRecord() public {
        bytes32 a = proofs.record(real);
        vm.recordLogs();
        bytes32 b = proofs.record(real);
        assertEq(a, b);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_UnknownProofListsNothing() public view {
        assertFalse(proofs.lists(keccak256("nothing"), KALIBRE));
    }

    function test_ReadsALowerCaseAddress() public {
        Attestation memory att = withData(string.concat('{"payTo":"', vm.toLowercase(vm.toString(KALIBRE)), '"}'));
        assertTrue(testProofs.lists(testProofs.record(att), KALIBRE));
    }

    function test_RefusesAValueThatIsNotAnAddress() public {
        string[3] memory values = [
            '{"payTo":"0x90f9931B748B26763161a8191C178Fe425C25fEZ"}',
            '{"payTo":"0x90f9931B748B26763161a8191C178Fe425C25f"}',
            '{"payTo":"0x90f9931B748B26763161a8191C178Fe425C25fEc","x":1}'
        ];
        for (uint256 i = 0; i < values.length; i++) {
            Attestation memory att = withData(values[i]); // signed first: expectRevert binds the next call
            vm.expectRevert(SupplierProofs.NotAnAddress.selector);
            testProofs.record(att);
        }
    }

    // --- The website's file, and nothing else ---

    function test_RefusesAnythingButAnHttpsSitesAddressFile() public {
        string[5] memory urls = [
            "http://countersign-supplier-demo.vercel.app/.well-known/countersign.json",
            "https://countersign-supplier-demo.vercel.app/files/.well-known/countersign.json",
            "https://countersign-supplier-demo.vercel.app/.well-known/countersign.json?x=1",
            "https://user@countersign-supplier-demo.vercel.app/.well-known/countersign.json",
            "https:///.well-known/countersign.json"
        ];
        for (uint256 i = 0; i < urls.length; i++) {
            Attestation memory att = real;
            att.request.url = urls[i];
            att = signWithTestKey(att);
            vm.expectRevert(SupplierProofs.NotAnAddressFile.selector);
            testProofs.record(att);
        }
    }

    function test_RefusesAnotherRequestShape() public {
        Attestation memory post = real;
        post.request.method = "POST";
        post = signWithTestKey(post);
        vm.expectRevert(SupplierProofs.WrongRequest.selector);
        testProofs.record(post);

        Attestation memory body = real;
        body.request.body = "x";
        body = signWithTestKey(body);
        vm.expectRevert(SupplierProofs.WrongRequest.selector);
        testProofs.record(body);

        Attestation memory header = real;
        header.request.header = '{"Cookie":"x"}';
        header = signWithTestKey(header);
        vm.expectRevert(SupplierProofs.WrongRequest.selector);
        testProofs.record(header);
    }

    function test_RefusesOtherFields() public {
        Attestation memory path = real;
        path.reponseResolve[0].parsePath = "$.other";
        path = signWithTestKey(path);
        vm.expectRevert(SupplierProofs.WrongFields.selector);
        testProofs.record(path);

        Attestation memory key = real;
        key.reponseResolve[0].keyName = "other";
        key = signWithTestKey(key);
        vm.expectRevert(SupplierProofs.WrongFields.selector);
        testProofs.record(key);

        Attestation memory mode = real;
        mode.additionParams = '{"algorithmType":"mpctls"}';
        mode = signWithTestKey(mode);
        vm.expectRevert(SupplierProofs.WrongFields.selector);
        testProofs.record(mode);
    }

    // --- Time ---

    function test_RefusesAProofOlderThanAnHour() public {
        vm.warp(real.timestamp / 1000 + 1 hours + 1);
        vm.expectRevert(abi.encodeWithSelector(SupplierProofs.ProofTooOld.selector, 1 hours + 1));
        proofs.record(real);
    }

    function test_RefusesAProofFromTheFuture() public {
        vm.warp(real.timestamp / 1000 - 301);
        vm.expectRevert(SupplierProofs.ProofFromFuture.selector);
        proofs.record(real);
    }

    // --- Signatures (Primus's verifier) ---

    function test_RefusesAnEditedProof() public {
        Attestation memory att = real;
        att.data = string.concat('{"payTo":"', vm.toString(makeAddr("fraudster")), '"}');
        vm.expectRevert("Invalid signature");
        proofs.record(att);
    }

    function test_RefusesAProofSignedByAnotherKey() public {
        Attestation memory att = signWithTestKey(real);
        vm.expectRevert("Invalid signature");
        proofs.record(att);
    }

    function test_AnEditedAttestorListDoesNotHelp() public {
        Attestation memory att = signWithTestKey(real);
        att.attestors[0].attestorAddr = testSigner;
        vm.expectRevert("Invalid signature");
        proofs.record(att);
    }

    // --- Neighbouring fields in Primus's packed hash are pinned (Spike 2, finding 2) ---

    function test_UrlShiftedIntoTheHeaderIsRefused() public {
        Attestation memory att = real;
        att.request.url = "https://countersign-supplier-demo.vercel.app/.well-known/countersign.jso";
        att.request.header = "n";
        IPrimusZKTLS(address(proofs.verifier())).verifyAttestation(att); // Primus alone accepts it
        vm.expectRevert(SupplierProofs.NotAnAddressFile.selector);
        proofs.record(att);
    }

    function test_DataShiftedIntoTheConditionsIsRefused() public {
        Attestation memory att = real;
        att.data = '{"payTo":"0x90f9931B748B26763161a8191C178Fe425C25fEc"';
        att.attConditions = string.concat("}", real.attConditions);
        IPrimusZKTLS(address(proofs.verifier())).verifyAttestation(att); // Primus alone accepts it
        vm.expectRevert(SupplierProofs.WrongFields.selector);
        proofs.record(att);
    }

    function test_GasToRecord() public {
        uint256 g = gasleft();
        proofs.record(real);
        emit log_named_uint("record a supplier proof (gas)", g - gasleft());
    }
}
