// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin-contracts/proxy/Clones.sol";
import {CountersignAccount} from "./CountersignAccount.sol";
import {OrderVault} from "./OrderVault.sol";

/// @title AccountFactory
/// @notice Creates company accounts bound to a passkey, at addresses known in advance so an
/// account can be funded before it exists.
/// @dev The address commits to the passkey, the starting waiting period and a salt. Anyone
/// may call `createAccount` (a relayer usually does); whoever calls it first can only create
/// exactly the account the owner expects, and the account is initialised in the same
/// transaction, so no clone is ever left uninitialised.
contract AccountFactory {
    event AccountCreated(address indexed account, bytes32 indexed qx, bytes32 qy, uint64 waitingPeriod, bytes32 salt);

    IERC20 public immutable usdc;
    address public immutable vaultTemplate;
    address public immutable accountTemplate;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
        vaultTemplate = address(new OrderVault(usdc_));
        accountTemplate = address(new CountersignAccount(usdc_, vaultTemplate));
    }

    /// @return account The account's address; if it already exists, the same address.
    function createAccount(bytes32 qx, bytes32 qy, uint64 waitingPeriod, bytes32 salt)
        external
        returns (address account)
    {
        bytes32 s = _salt(qx, qy, waitingPeriod, salt);
        account = Clones.predictDeterministicAddress(accountTemplate, s);
        if (account.code.length > 0) return account;
        Clones.cloneDeterministic(accountTemplate, s);
        CountersignAccount(account).initialize(qx, qy, waitingPeriod);
        emit AccountCreated(account, qx, qy, waitingPeriod, salt);
    }

    function predictAccount(bytes32 qx, bytes32 qy, uint64 waitingPeriod, bytes32 salt)
        external
        view
        returns (address)
    {
        return Clones.predictDeterministicAddress(accountTemplate, _salt(qx, qy, waitingPeriod, salt));
    }

    function _salt(bytes32 qx, bytes32 qy, uint64 waitingPeriod, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy, waitingPeriod, salt));
    }
}
