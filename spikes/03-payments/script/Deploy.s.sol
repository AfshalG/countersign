// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {SharedAccount} from "../src/SharedAccount.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
contract Deploy is Script {
    IERC20 constant USDC = IERC20(0x534b2f3A21130d7a60830c2Df862319e593943A3);

    function run() external returns (VaultFactory factory, SharedAccount account) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address checker = vm.addr(vm.envUint("SPIKE3_CHECKER_PRIVATE_KEY"));
        vm.startBroadcast(key);
        factory = new VaultFactory(USDC, checker);
        account = new SharedAccount(USDC, checker);
        vm.stopBroadcast();
        console.log("VaultFactory", address(factory));
        console.log("OrderVault implementation", factory.implementation());
        console.log("SharedAccount", address(account));
    }
}
