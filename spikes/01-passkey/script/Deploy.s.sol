// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {PasskeyProbe} from "../src/PasskeyProbe.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
contract Deploy is Script {
    function run() external returns (PasskeyProbe probe) {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        probe = new PasskeyProbe();
        vm.stopBroadcast();
    }
}
