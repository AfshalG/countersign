// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin-contracts/proxy/Clones.sol";
import {OrderVault} from "./OrderVault.sol";

/// @title VaultFactory (Spike 3, throwaway)
/// @notice Creates and funds a vault per order in one transaction. The salt includes the
/// caller, so nobody else can take a vault address another caller is about to use.
contract VaultFactory {
    using SafeERC20 for IERC20;

    event OrderOpened(address indexed vault, address indexed supplier, uint256 amount);

    IERC20 public immutable token;
    address public immutable checker;
    address public immutable implementation;

    constructor(IERC20 token_, address checker_) {
        token = token_;
        checker = checker_;
        implementation = address(new OrderVault());
    }

    function openOrder(address supplier, uint256 amount, bytes32 salt) public returns (address vault) {
        vault = Clones.cloneDeterministicWithImmutableArgs(
            implementation, abi.encode(token, supplier, checker), _salt(supplier, salt)
        );
        token.safeTransferFrom(msg.sender, vault, amount);
        emit OrderOpened(vault, supplier, amount);
    }

    function openOrders(address[] calldata suppliers, uint256 amount, bytes32[] calldata salts)
        external
        returns (address[] memory vaults)
    {
        vaults = new address[](suppliers.length);
        for (uint256 i; i < suppliers.length; i++) {
            vaults[i] = openOrder(suppliers[i], amount, salts[i]);
        }
    }

    function predictVault(address supplier, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddressWithImmutableArgs(
            implementation, abi.encode(token, supplier, checker), _salt(supplier, salt)
        );
    }

    function _salt(address supplier, bytes32 salt) private view returns (bytes32) {
        return keccak256(abi.encode(msg.sender, supplier, salt));
    }
}
