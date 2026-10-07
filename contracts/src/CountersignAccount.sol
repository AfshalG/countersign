// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin-contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {EIP712} from "@openzeppelin-contracts/utils/cryptography/EIP712.sol";
import {P256} from "@openzeppelin-contracts/utils/cryptography/P256.sol";
import {SafeCast} from "@openzeppelin-contracts/utils/math/SafeCast.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Policy, Supplier, PaymentContext} from "./CountersignTypes.sol";
import {OwnerAuth} from "./libraries/OwnerAuth.sol";
import {ICountersignAccount} from "./interfaces/ICountersignAccount.sol";
import {IOrderVault} from "./interfaces/IOrderVault.sol";
import "./CountersignErrors.sol";

/// @title CountersignAccount
/// @notice A company's account: owned by a passkey, holds its USDC, keeps its suppliers and
/// their one payable address each, and opens a vault per approved order. Every change is an
/// owner action signed with the passkey; the agent and the checker can only pay approved
/// orders, through their vaults, under the rules in PaymentRules.
/// @dev Deployed as a clone by AccountFactory and initialised in the same transaction.
/// `usdc` and `vaultTemplate` are immutables of the template, which clones share.
contract CountersignAccount is Initializable, EIP712, ICountersignAccount {
    using SafeERC20 for IERC20;

    event PolicySet(
        address agentKey,
        address checkerKey,
        uint128 perPaymentCap,
        uint128 newAddressCap,
        uint64 newAddressPeriod,
        uint64 waitingPeriod,
        uint64 expiry
    );
    event WaitingPeriodDecreaseScheduled(uint64 waitingPeriod, uint64 effectiveAt);
    event SupplierSet(bytes32 indexed supplierId, address payTo, bool active, uint64 activeAfter, bytes32 proofHash);
    event OrderApproved(
        bytes32 indexed orderId,
        address vault,
        bytes32 indexed supplierId,
        bytes32 orderHash,
        uint256 amount,
        uint64 expiry
    );
    event OrderClosed(bytes32 indexed orderId, address vault, uint256 returned);
    event Withdrawn(address to, uint256 amount);
    event Paused();
    event Unpaused();

    /// The longest waiting period allowed. A decrease waits out the current period, so an
    /// unbounded one could lock supplier changes for good.
    uint64 public constant MAX_WAITING_PERIOD = 30 days;

    IERC20 public immutable usdc;
    address public immutable vaultTemplate;

    bytes32 private _qx;
    bytes32 private _qy;
    uint256 public ownerNonce;
    bool public paused;
    Policy private _policy;
    /// A lower waiting period takes effect only after the current one has passed (D28).
    uint64 private _pendingWaitingPeriod;
    uint64 private _pendingWaitingPeriodAt;
    mapping(bytes32 supplierId => Supplier) private _suppliers;
    mapping(bytes32 orderId => address vault) public vaultOf;

    constructor(IERC20 usdc_, address vaultTemplate_) EIP712("Countersign Account", "1") {
        if (address(usdc_) == address(0) || vaultTemplate_ == address(0)) revert InvalidPayTo();
        usdc = usdc_;
        vaultTemplate = vaultTemplate_;
        _disableInitializers();
    }

    /// @notice Binds the account to its passkey. No agent or checker key is set, so nothing
    /// can be paid until the owner sets a policy.
    function initialize(bytes32 qx, bytes32 qy, uint64 waitingPeriod) external initializer {
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidOwnerKey();
        if (waitingPeriod > MAX_WAITING_PERIOD) revert InvalidPolicy();
        _qx = qx;
        _qy = qy;
        _policy.waitingPeriod = waitingPeriod;
    }

    // ---------- owner actions ----------

    function setPolicy(Policy calldata p, uint256 nonce, uint64 deadline, WebAuthn.WebAuthnAuth calldata auth)
        external
    {
        _authorize(OwnerAuth.setPolicyHash(p, nonce, deadline), nonce, deadline, auth);
        if (p.agentKey == address(0) || p.checkerKey == address(0)) revert InvalidPolicy();
        // One key signing both halves would turn two signatures into one.
        if (p.agentKey == p.checkerKey) revert SameAgentAndChecker();
        if (p.newAddressCap > p.perPaymentCap) revert InvalidPolicy();
        if (p.expiry <= block.timestamp) revert InvalidPolicy();
        if (p.waitingPeriod > MAX_WAITING_PERIOD) revert InvalidPolicy();

        uint64 current = effectiveWaitingPeriod();
        uint64 wait = p.waitingPeriod;
        if (wait < current) {
            // Lowering it waits out the current period, so a tricked owner cannot set it
            // to zero and add a fraudster's address in the same minute.
            wait = current;
            _pendingWaitingPeriod = p.waitingPeriod;
            _pendingWaitingPeriodAt = SafeCast.toUint64(block.timestamp) + current;
            emit WaitingPeriodDecreaseScheduled(p.waitingPeriod, _pendingWaitingPeriodAt);
        } else {
            _pendingWaitingPeriod = 0;
            _pendingWaitingPeriodAt = 0;
        }
        _policy = Policy({
            agentKey: p.agentKey,
            checkerKey: p.checkerKey,
            perPaymentCap: p.perPaymentCap,
            newAddressCap: p.newAddressCap,
            newAddressPeriod: p.newAddressPeriod,
            waitingPeriod: wait,
            expiry: p.expiry
        });
        emit PolicySet(
            p.agentKey, p.checkerKey, p.perPaymentCap, p.newAddressCap, p.newAddressPeriod, p.waitingPeriod, p.expiry
        );
    }

    function setSupplier(
        bytes32 supplierId,
        address payTo,
        bool active,
        bytes32 proofHash,
        uint256 nonce,
        uint64 deadline,
        WebAuthn.WebAuthnAuth calldata auth
    ) external {
        _authorize(
            OwnerAuth.setSupplierHash(supplierId, payTo, active, proofHash, nonce, deadline), nonce, deadline, auth
        );
        if (payTo == address(0)) revert InvalidPayTo();
        Supplier storage s = _suppliers[supplierId];
        // A new or changed address waits; turning a supplier on or off does not reset it.
        if (s.payTo != payTo) {
            s.payTo = payTo;
            s.activeAfter = SafeCast.toUint64(block.timestamp) + effectiveWaitingPeriod();
        }
        s.active = active;
        s.proofHash = proofHash;
        emit SupplierSet(supplierId, payTo, active, s.activeAfter, proofHash);
    }

    function approveOrder(
        bytes32 orderId,
        bytes32 supplierId,
        bytes32 orderHash,
        uint256 amount,
        uint64 expiry,
        uint256 nonce,
        uint64 deadline,
        WebAuthn.WebAuthnAuth calldata auth
    ) external returns (address vault) {
        _authorize(
            OwnerAuth.approveOrderHash(orderId, supplierId, orderHash, amount, expiry, nonce, deadline),
            nonce,
            deadline,
            auth
        );
        Supplier storage s = _suppliers[supplierId];
        if (s.payTo == address(0)) revert UnknownSupplier();
        if (!s.active) revert SupplierInactive();
        if (vaultOf[orderId] != address(0)) revert OrderExists();
        if (amount == 0 || expiry <= block.timestamp) revert InvalidOrder();
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientBalance();

        vault = Clones.cloneDeterministicWithImmutableArgs(
            vaultTemplate, _vaultArgs(supplierId, orderHash, expiry, amount), orderId
        );
        vaultOf[orderId] = vault;
        emit OrderApproved(orderId, vault, supplierId, orderHash, amount, expiry);
        usdc.safeTransfer(vault, amount);
    }

    function closeOrder(bytes32 orderId, uint256 nonce, uint64 deadline, WebAuthn.WebAuthnAuth calldata auth)
        external
        returns (uint256 returned)
    {
        _authorize(OwnerAuth.closeOrderHash(orderId, nonce, deadline), nonce, deadline, auth);
        address vault = vaultOf[orderId];
        if (vault == address(0)) revert UnknownOrder();
        returned = IOrderVault(vault).close();
        emit OrderClosed(orderId, vault, returned);
    }

    /// @notice Sends money not set aside for an order to an address the owner signed for.
    /// Works while paused (D23).
    function withdraw(address to, uint256 amount, uint256 nonce, uint64 deadline, WebAuthn.WebAuthnAuth calldata auth)
        external
    {
        _authorize(OwnerAuth.withdrawHash(to, amount, nonce, deadline), nonce, deadline, auth);
        if (to == address(0)) revert InvalidPayTo();
        if (amount == 0) revert ZeroAmount();
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientBalance();
        emit Withdrawn(to, amount);
        usdc.safeTransfer(to, amount);
    }

    /// @notice The stop button: every vault refuses to pay until unpaused (D23).
    function pause(uint256 nonce, uint64 deadline, WebAuthn.WebAuthnAuth calldata auth) external {
        _authorize(OwnerAuth.pauseHash(nonce, deadline), nonce, deadline, auth);
        if (paused) revert AlreadyPaused();
        paused = true;
        emit Paused();
    }

    function unpause(uint256 nonce, uint64 deadline, WebAuthn.WebAuthnAuth calldata auth) external {
        _authorize(OwnerAuth.unpauseHash(nonce, deadline), nonce, deadline, auth);
        if (!paused) revert NotPaused();
        paused = false;
        emit Unpaused();
    }

    /// @dev Deadline, then nonce, then the passkey over the digest computed here (never a
    /// digest from the caller). The nonce is used only if the whole action succeeds.
    function _authorize(bytes32 structHash, uint256 nonce, uint64 deadline, WebAuthn.WebAuthnAuth calldata auth)
        private
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (nonce != ownerNonce) revert BadNonce();
        if (!OwnerAuth.verify(_hashTypedDataV4(structHash), auth, _qx, _qy)) revert InvalidOwnerSignature();
        ownerNonce = nonce + 1;
    }

    // ---------- reads ----------

    /// @inheritdoc ICountersignAccount
    function paymentContext(bytes32 supplierId) external view returns (PaymentContext memory ctx) {
        Supplier storage s = _suppliers[supplierId];
        Policy storage p = _policy;
        ctx = PaymentContext({
            payTo: s.payTo,
            activeAfter: s.activeAfter,
            supplierActive: s.active,
            agentKey: p.agentKey,
            checkerKey: p.checkerKey,
            perPaymentCap: p.perPaymentCap,
            newAddressCap: p.newAddressCap,
            newAddressPeriod: p.newAddressPeriod,
            policyExpiry: p.expiry,
            paused: paused,
            ownerQx: _qx,
            ownerQy: _qy
        });
    }

    function ownerKey() external view returns (bytes32 qx, bytes32 qy) {
        return (_qx, _qy);
    }

    function policy() external view returns (Policy memory) {
        return _policy;
    }

    function supplier(bytes32 supplierId) external view returns (Supplier memory) {
        return _suppliers[supplierId];
    }

    /// The waiting period that applies to an address set now.
    function effectiveWaitingPeriod() public view returns (uint64) {
        if (_pendingWaitingPeriodAt != 0 && block.timestamp >= _pendingWaitingPeriodAt) return _pendingWaitingPeriod;
        return _policy.waitingPeriod;
    }

    function pendingWaitingPeriod() external view returns (uint64 waitingPeriod, uint64 effectiveAt) {
        return (_pendingWaitingPeriod, _pendingWaitingPeriodAt);
    }

    /// The EIP-712 digest the passkey signs for an owner action, in this account's domain.
    function ownerDigest(bytes32 structHash) external view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }

    function predictVault(bytes32 orderId, bytes32 supplierId, bytes32 orderHash, uint64 expiry, uint256 amount)
        external
        view
        returns (address)
    {
        return Clones.predictDeterministicAddressWithImmutableArgs(
            vaultTemplate, _vaultArgs(supplierId, orderHash, expiry, amount), orderId
        );
    }

    function _vaultArgs(bytes32 supplierId, bytes32 orderHash, uint64 expiry, uint256 amount)
        private
        view
        returns (bytes memory)
    {
        return abi.encode(address(this), supplierId, orderHash, expiry, amount);
    }
}
