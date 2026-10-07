// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./helpers/Base.sol";
import {OrderVault} from "../src/OrderVault.sol";
import {OwnerAuth} from "../src/libraries/OwnerAuth.sol";
import {Policy, Payment, Decision} from "../src/CountersignTypes.sol";

/// @notice Digests the contracts compute for fixed sample values, shared with the TypeScript
/// types in packages/shared (test/eip712.test.ts uses the same samples). By default this test
/// checks the committed fixture; with WRITE_EIP712_FIXTURES=1 it rewrites it.
contract Eip712FixtureTest is Base {
    string constant PATH = "../packages/shared/test/fixtures/eip712.json";

    // The same samples as packages/shared/test/eip712.test.ts.
    uint256 constant NONCE = 7;
    uint64 constant DEADLINE = 1_790_003_600;
    address constant A1 = 0x1000000000000000000000000000000000000001;
    address constant A2 = 0x2000000000000000000000000000000000000002;
    address constant A3 = 0x3000000000000000000000000000000000000003;
    address constant A4 = 0x4000000000000000000000000000000000000004;

    function _digests(OrderVault vault) internal view returns (bytes32[9] memory d) {
        Policy memory p = Policy({
            agentKey: A1,
            checkerKey: A2,
            perPaymentCap: 100_000,
            newAddressCap: 20_000,
            newAddressPeriod: 604_800,
            waitingPeriod: 172_800,
            expiry: 1_821_536_000
        });
        bytes32 supplierId = keccak256("kalibre-studio");
        bytes32 orderId = keccak256("order-2026-001");
        d[0] = account.ownerDigest(OwnerAuth.setPolicyHash(p, NONCE, DEADLINE));
        d[1] = account.ownerDigest(OwnerAuth.setSupplierHash(supplierId, A3, true, keccak256("proof"), NONCE, DEADLINE));
        d[2] = account.ownerDigest(
            OwnerAuth.approveOrderHash(
                orderId, supplierId, keccak256("purchase order 2026-001, PDF"), 50_000, 1_792_592_000, NONCE, DEADLINE
            )
        );
        d[3] = account.ownerDigest(OwnerAuth.closeOrderHash(orderId, NONCE, DEADLINE));
        d[4] = account.ownerDigest(OwnerAuth.withdrawHash(A4, 400_000, NONCE, DEADLINE));
        d[5] = account.ownerDigest(OwnerAuth.pauseHash(NONCE, DEADLINE));
        d[6] = account.ownerDigest(OwnerAuth.unpauseHash(NONCE, DEADLINE));
        d[7] = vault.paymentDigest(
            Payment({amount: 10_000, invoiceHash: keccak256("invoice INV-0042, PDF"), payTo: A3, deadline: DEADLINE})
        );
        d[8] = vault.decisionDigest(
            Decision({
                invoiceHash: keccak256("invoice INV-0042, PDF"),
                outcome: 1,
                reasonHash: keccak256("address differs from the one on file"),
                evidenceHash: keccak256("invoice.pdf")
            })
        );
    }

    function test_DigestsMatchTheSharedFixture() public {
        OrderVault vault = _readyVault();
        bytes32[9] memory d = _digests(vault);
        string[9] memory names = [
            "SetPolicy",
            "SetSupplier",
            "ApproveOrder",
            "CloseOrder",
            "Withdraw",
            "Pause",
            "Unpause",
            "Payment",
            "Decision"
        ];

        if (vm.envOr("WRITE_EIP712_FIXTURES", false)) {
            string memory obj = "eip712";
            vm.serializeUint(obj, "chainId", block.chainid);
            vm.serializeAddress(obj, "account", address(account));
            vm.serializeAddress(obj, "vault", address(vault));
            string memory json;
            for (uint256 i; i < 9; i++) {
                json = vm.serializeBytes32(obj, names[i], d[i]);
            }
            vm.writeJson(json, PATH);
            return;
        }

        string memory fixture = vm.readFile(PATH);
        assertEq(vm.parseJsonUint(fixture, ".chainId"), block.chainid);
        assertEq(vm.parseJsonAddress(fixture, ".account"), address(account));
        assertEq(vm.parseJsonAddress(fixture, ".vault"), address(vault));
        for (uint256 i; i < 9; i++) {
            assertEq(vm.parseJsonBytes32(fixture, string.concat(".", names[i])), d[i], names[i]);
        }
    }
}
