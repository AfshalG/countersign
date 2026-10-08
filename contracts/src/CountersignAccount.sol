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
import {Policy, Supplier, PaymentContext, OwnerKey, OwnerSig, OwnerPurpose} from "./CountersignTypes.sol";
import {OwnerAuth} from "./libraries/OwnerAuth.sol";
import {ICountersignAccount} from "./interfaces/ICountersignAccount.sol";
import {IOrderVault} from "./interfaces/IOrderVault.sol";
import "./CountersignErrors.sol";

/// @title CountersignAccount
/// @notice A company's account: owned by one to five passkeys (D36), holds its USDC, keeps its suppliers and
/// their one payable address each, and opens a vault per approved order. Every change is an
/// owner action signed with enough owners' passkeys; the agent and the checker can only pay approved
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
    event OwnersSet(uint256 count, uint8 manageThreshold, uint8 releaseThreshold);

    /// The longest waiting period allowed. A decrease waits out the current period, so an
    /// unbounded one could lock supplier changes for good.
    uint64 public constant MAX_WAITING_PERIOD = 30 days;
    /// The most owners an account can have (D36).
    uint8 public constant MAX_OWNERS = 5;

    IERC20 public immutable usdc;
    address public immutable vaultTemplate;

    OwnerKey[] private _owners;
    /// Owners needed to manage the account (policy, suppliers, orders, withdrawals, owners, unpause).
    uint8 public manageThreshold;
    /// Owners needed to pay a held payment once.
    uint8 public releaseThreshold;
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

    /// @notice Binds the account to its first passkey, with thresholds of one; more owners are
    /// added with `setOwners`. No agent or checker key is set, so nothing can be paid until the
    /// owner sets a policy.
    function initialize(bytes32 qx, bytes32 qy, uint64 waitingPeriod) external initializer {
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidOwnerKey();
        if (waitingPeriod > MAX_WAITING_PERIOD) revert InvalidPolicy();
        _owners.push(OwnerKey({qx: qx, qy: qy}));
        manageThreshold = 1;
        releaseThreshold = 1;
        _policy.waitingPeriod = waitingPeriod;
    }

    // ---------- owner actions ----------

    function setPolicy(Policy calldata p, uint256 nonce, uint64 deadline, OwnerSig[] calldata sigs) external {
        _authorize(OwnerAuth.setPolicyHash(p, nonce, deadline), nonce, deadline, sigs, OwnerPurpose.Manage);
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
        OwnerSig[] calldata sigs
    ) external {
        _authorize(
            OwnerAuth.setSupplierHash(supplierId, payTo, active, proofHash, nonce, deadline),
            nonce,
            deadline,
            sigs,
            OwnerPurpose.Manage
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
        OwnerSig[] calldata sigs
    ) external returns (address vault) {
        _authorize(
            OwnerAuth.approveOrderHash(orderId, supplierId, orderHash, amount, expiry, nonce, deadline),
            nonce,
            deadline,
            sigs,
            OwnerPurpose.Manage
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

    function closeOrder(bytes32 orderId, uint256 nonce, uint64 deadline, OwnerSig[] calldata sigs)
        external
        returns (uint256 returned)
    {
        _authorize(OwnerAuth.closeOrderHash(orderId, nonce, deadline), nonce, deadline, sigs, OwnerPurpose.Manage);
        address vault = vaultOf[orderId];
        if (vault == address(0)) revert UnknownOrder();
        returned = IOrderVault(vault).close();
        emit OrderClosed(orderId, vault, returned);
    }

    /// @notice Sends money not set aside for an order to an address the owner signed for.
    /// Works while paused (D23).
    function withdraw(address to, uint256 amount, uint256 nonce, uint64 deadline, OwnerSig[] calldata sigs) external {
        _authorize(OwnerAuth.withdrawHash(to, amount, nonce, deadline), nonce, deadline, sigs, OwnerPurpose.Manage);
        if (to == address(0)) revert InvalidPayTo();
        if (amount == 0) revert ZeroAmount();
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientBalance();
        emit Withdrawn(to, amount);
        usdc.safeTransfer(to, amount);
    }

    /// @notice The stop button: every vault refuses to pay until unpaused (D23). Any one owner
    /// can press it; starting again (unpause) needs the manage threshold.
    function pause(uint256 nonce, uint64 deadline, OwnerSig[] calldata sigs) external {
        _authorize(OwnerAuth.pauseHash(nonce, deadline), nonce, deadline, sigs, OwnerPurpose.AnyOne);
        if (paused) revert AlreadyPaused();
        paused = true;
        emit Paused();
    }

    function unpause(uint256 nonce, uint64 deadline, OwnerSig[] calldata sigs) external {
        _authorize(OwnerAuth.unpauseHash(nonce, deadline), nonce, deadline, sigs, OwnerPurpose.Manage);
        if (!paused) revert NotPaused();
        paused = false;
        emit Unpaused();
    }

    /// @notice Replaces the owners and the thresholds (D36), signed by the manage threshold of
    /// the current owners. One to five keys, each on the curve and none twice; each threshold at
    /// least one and at most the number of owners.
    function setOwners(
        OwnerKey[] calldata keys,
        uint8 manage,
        uint8 release,
        uint256 nonce,
        uint64 deadline,
        OwnerSig[] calldata sigs
    ) external {
        _authorize(
            OwnerAuth.setOwnersHash(keys, manage, release, nonce, deadline), nonce, deadline, sigs, OwnerPurpose.Manage
        );
        uint256 n = keys.length;
        if (n == 0 || n > MAX_OWNERS) revert InvalidOwners();
        if (manage == 0 || manage > n || release == 0 || release > n) revert InvalidOwners();
        for (uint256 i = 0; i < n; i++) {
            if (!P256.isValidPublicKey(keys[i].qx, keys[i].qy)) revert InvalidOwnerKey();
            for (uint256 j = 0; j < i; j++) {
                if (keys[i].qx == keys[j].qx && keys[i].qy == keys[j].qy) revert InvalidOwners();
            }
        }
        delete _owners;
        for (uint256 i = 0; i < n; i++) {
            _owners.push(keys[i]);
        }
        manageThreshold = manage;
        releaseThreshold = release;
        emit OwnersSet(n, manage, release);
    }

    /// @dev Deadline, then nonce, then enough owners' passkeys over the digest computed here
    /// (never a digest from the caller). The nonce is used only if the whole action succeeds.
    function _authorize(
        bytes32 structHash,
        uint256 nonce,
        uint64 deadline,
        OwnerSig[] calldata sigs,
        OwnerPurpose purpose
    ) private {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (nonce != ownerNonce) revert BadNonce();
        _requireOwners(_hashTypedDataV4(structHash), sigs, purpose);
        ownerNonce = nonce + 1;
    }

    /// @dev Too few signatures fail before any is checked (cheap, and how the gateway learns it
    /// must wait for another owner). Then every signature given must be valid, from an owner the
    /// account has, in strictly increasing owner order so that none counts twice.
    function _requireOwners(bytes32 digest, OwnerSig[] calldata sigs, OwnerPurpose purpose) private view {
        uint256 need =
            purpose == OwnerPurpose.Manage ? manageThreshold : purpose == OwnerPurpose.Release ? releaseThreshold : 1;
        if (sigs.length < need) revert NotEnoughSigners();
        uint256 count = _owners.length;
        for (uint256 i = 0; i < sigs.length; i++) {
            uint8 o = sigs[i].owner;
            if (i > 0 && o <= sigs[i - 1].owner) revert OwnersOutOfOrder();
            if (o >= count) revert UnknownOwner();
            OwnerKey storage k = _owners[o];
            if (!OwnerAuth.verify(digest, sigs[i].auth, k.qx, k.qy)) revert InvalidOwnerSignature();
        }
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
            paused: paused
        });
    }

    /// @inheritdoc ICountersignAccount
    function requireOwners(bytes32 digest, OwnerSig[] calldata sigs, OwnerPurpose purpose) external view {
        _requireOwners(digest, sigs, purpose);
    }

    /// The owners' passkeys, in the order signatures name them.
    function owners() external view returns (OwnerKey[] memory) {
        return _owners;
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
