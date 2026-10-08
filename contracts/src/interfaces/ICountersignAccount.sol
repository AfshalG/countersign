// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymentContext, OwnerSig, OwnerPurpose} from "../CountersignTypes.sol";

/// What a vault reads from its account. Reads only: payments never write the account.
interface ICountersignAccount {
    function paymentContext(bytes32 supplierId) external view returns (PaymentContext memory);

    /// Reverts unless enough of the account's owners signed `digest` for `purpose` (D36):
    /// each signature valid, owners in strictly increasing order, the threshold met.
    function requireOwners(bytes32 digest, OwnerSig[] calldata sigs, OwnerPurpose purpose) external view;
}
