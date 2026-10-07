// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymentContext} from "../CountersignTypes.sol";

/// What a vault reads from its account. Reads only: payments never write the account.
interface ICountersignAccount {
    function paymentContext(bytes32 supplierId) external view returns (PaymentContext memory);
}
