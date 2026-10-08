// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {PrimusZKTLS} from "primus/PrimusZKTLS.sol";
import {IPrimusZKTLS, Attestor} from "primus/IPrimusZKTLS.sol";
import {SupplierProofProbe} from "../src/SupplierProofProbe.sol";

/// Deploys Primus's verifier the way Primus does (behind a proxy, initialised in the same
/// transaction, so nobody can initialise it first), trusting only Primus's attestor, then the probe.
/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
contract Deploy is Script {
    address constant PRIMUS_ATTESTOR = 0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6;

    function run() external returns (IPrimusZKTLS verifier, SupplierProofProbe probe) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(key);
        Attestor[] memory attestors = new Attestor[](1);
        attestors[0] = Attestor({attestorAddr: PRIMUS_ATTESTOR, url: "https://primuslabs.xyz"});

        vm.startBroadcast(key);
        PrimusZKTLS logic = new PrimusZKTLS();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(logic), owner, abi.encodeCall(PrimusZKTLS.initialize, (owner, attestors))
        );
        verifier = IPrimusZKTLS(address(proxy));
        probe = new SupplierProofProbe(verifier, 24 hours);
        vm.stopBroadcast();

        console.log("PrimusZKTLS logic", address(logic));
        console.log("PrimusZKTLS proxy (verifier)", address(proxy));
        console.log("SupplierProofProbe", address(probe));
    }
}
