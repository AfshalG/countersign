// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IPrimusZKTLS} from "primus/IPrimusZKTLS.sol";
import {SupplierProofs} from "../src/SupplierProofs.sol";

/// @notice Slice 15 on Monad testnet: the registry of suppliers' website proofs.
///
///   forge script script/SupplierProofsTestnet.s.sol --sig "deploy()" --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///
/// It trusts the Primus verifier Spike 2 deployed on testnet (Primus's own verifier code behind a
/// proxy, initialised in the same transaction, trusting only Primus's attestor 0xDB73…8eF6), and
/// adds its address to deployments/10143.json. Gas limits are the node's estimate plus 8% (fees
/// are charged on the limit on Monad).
contract SupplierProofsTestnet is Script {
    IPrimusZKTLS constant PRIMUS_VERIFIER = IPrimusZKTLS(0x643C855Aaee9Fe8e37B5e3dE19e75A889d3218FE);
    string constant DEPLOYMENTS = "deployments/10143.json";

    function deploy() external {
        require(block.chainid == 10143, "Monad testnet only");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        SupplierProofs proofs = new SupplierProofs(PRIMUS_VERIFIER);
        vm.stopBroadcast();
        vm.writeJson(vm.toString(address(proofs)), DEPLOYMENTS, ".supplierProofs");
        console.log("SupplierProofs", address(proofs));
    }
}
