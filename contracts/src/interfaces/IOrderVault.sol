// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// What an account asks of its vaults.
interface IOrderVault {
    /// Marks the order closed and returns everything left in it to the account.
    function close() external returns (uint256 returned);
}
