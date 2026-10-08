// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin-contracts/utils/cryptography/EIP712.sol";

/// @title SharedAccount (Spike 3, throwaway): the control arm
/// @notice The same payment rules as OrderVault, but every order's money sits in one
/// account. Each order still has its own budget (otherwise one order could spend another's
/// money), so a payment writes that budget, its paid flag and, in the token, the account's
/// single balance: the shared storage every payment touches.
contract SharedAccount is EIP712 {
    using SafeERC20 for IERC20;

    error AlreadyPaid();
    error NotTheChecker();
    error InsufficientFunds();
    error UnknownOrder();
    error NotOwner();

    event Paid(uint256 indexed orderId, bytes32 indexed invoiceId, address indexed supplier, uint256 amount);

    bytes32 public constant PAYMENT_TYPEHASH =
        keccak256("Payment(uint256 orderId,bytes32 invoiceId,uint256 amount,address payTo)");

    IERC20 public immutable token;
    address public immutable checker;
    address public immutable owner;

    mapping(uint256 orderId => address) public orderSupplier;
    mapping(uint256 orderId => uint256) public budget;
    mapping(uint256 orderId => mapping(bytes32 invoiceId => bool)) public paid;

    constructor(IERC20 token_, address checker_) EIP712("Countersign Spike Account", "1") {
        token = token_;
        checker = checker_;
        owner = msg.sender;
    }

    function setOrder(uint256 orderId, address supplier, uint256 amount) public {
        if (msg.sender != owner) revert NotOwner();
        orderSupplier[orderId] = supplier;
        budget[orderId] = amount;
    }

    function setOrders(uint256[] calldata orderIds, address[] calldata suppliers, uint256 amount) external {
        for (uint256 i; i < orderIds.length; i++) {
            setOrder(orderIds[i], suppliers[i], amount);
        }
    }

    function paymentDigest(uint256 orderId, bytes32 invoiceId, uint256 amount) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(PAYMENT_TYPEHASH, orderId, invoiceId, amount, orderSupplier[orderId]))
            );
    }

    function pay(uint256 orderId, bytes32 invoiceId, uint256 amount, bytes calldata checkerSig) external {
        address supplier = orderSupplier[orderId];
        if (supplier == address(0)) revert UnknownOrder();
        if (paid[orderId][invoiceId]) revert AlreadyPaid();
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(paymentDigest(orderId, invoiceId, amount), checkerSig);
        if (err != ECDSA.RecoverError.NoError || signer != checker) revert NotTheChecker();
        if (budget[orderId] < amount) revert InsufficientFunds();
        budget[orderId] -= amount;
        paid[orderId][invoiceId] = true;
        token.safeTransfer(supplier, amount);
        emit Paid(orderId, invoiceId, supplier, amount);
    }
}
