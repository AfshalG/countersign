// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin-contracts/proxy/Clones.sol";
import {ECDSA} from "@openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin-contracts/utils/cryptography/EIP712.sol";

/// @title OrderVault (Spike 3, throwaway)
/// @notice One vault per order. Its token, supplier and checker are immutable arguments
/// baked into the clone, and its remaining budget is simply its own token balance, so the
/// only storage it ever writes is the paid-invoice flag. Payments from different vaults
/// therefore touch different storage, which is what Spike 3 measures.
/// @dev EIP712 rebuilds the domain for each clone's own address, so a signature for one
/// vault is useless on another (D22).
contract OrderVault is EIP712 {
    using SafeERC20 for IERC20;

    error AlreadyPaid();
    error NotTheChecker();
    error InsufficientFunds();

    event Paid(bytes32 indexed invoiceId, address indexed supplier, uint256 amount);

    bytes32 public constant PAYMENT_TYPEHASH = keccak256("Payment(bytes32 invoiceId,uint256 amount,address payTo)");

    mapping(bytes32 invoiceId => bool) public paid;

    constructor() EIP712("Countersign Spike Vault", "1") {}

    function _args() private view returns (IERC20 token_, address supplier_, address checker_) {
        return abi.decode(Clones.fetchCloneArgs(address(this)), (IERC20, address, address));
    }

    function token() external view returns (IERC20 t) {
        (t,,) = _args();
    }

    function supplier() external view returns (address s) {
        (, s,) = _args();
    }

    function checker() external view returns (address c) {
        (,, c) = _args();
    }

    function paymentDigest(bytes32 invoiceId, uint256 amount) public view returns (bytes32) {
        (, address s,) = _args();
        return _hashTypedDataV4(keccak256(abi.encode(PAYMENT_TYPEHASH, invoiceId, amount, s)));
    }

    function pay(bytes32 invoiceId, uint256 amount, bytes calldata checkerSig) external {
        (IERC20 t, address s, address c) = _args();
        if (paid[invoiceId]) revert AlreadyPaid();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(PAYMENT_TYPEHASH, invoiceId, amount, s)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, checkerSig);
        if (err != ECDSA.RecoverError.NoError || signer != c) revert NotTheChecker();
        if (t.balanceOf(address(this)) < amount) revert InsufficientFunds();
        paid[invoiceId] = true;
        t.safeTransfer(s, amount);
        emit Paid(invoiceId, s, amount);
    }
}
