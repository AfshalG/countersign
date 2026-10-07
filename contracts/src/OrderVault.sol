// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin-contracts/proxy/Clones.sol";
import {ECDSA} from "@openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin-contracts/utils/cryptography/EIP712.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Payment, Decision, PaymentContext, DecidedBy, OUTCOME_HELD, OUTCOME_BLOCKED} from "./CountersignTypes.sol";
import {PaymentRules, VaultState} from "./libraries/PaymentRules.sol";
import {OwnerAuth} from "./libraries/OwnerAuth.sol";
import {ICountersignAccount} from "./interfaces/ICountersignAccount.sol";
import {IOrderVault} from "./interfaces/IOrderVault.sol";
import "./CountersignErrors.sol";

/// @title OrderVault
/// @notice Holds the money for one approved order and pays only that order's supplier, at
/// the address on file, within what was set aside, with the agent's and the checker's
/// signatures or the owner's passkey.
/// @dev Deployed by its account as a clone whose fixed data (account, supplier, order hash,
/// expiry, amount) is in the clone's own code (`cloneDeterministicWithImmutableArgs`). There
/// is no initialiser, so nothing can be set by anyone else after creation, and opening an
/// order writes no vault storage. Only `spent`, the paid invoices and `closed` are stored;
/// a payment reads its account and writes nothing shared across vaults (D13).
/// EIP712 rebuilds the domain for each clone's address, so a signature for one vault is
/// useless on any other vault or chain (D22).
contract OrderVault is EIP712, IOrderVault {
    using SafeERC20 for IERC20;

    event PaymentExecuted(
        bytes32 indexed invoiceHash, address indexed payTo, uint256 amount, uint256 remaining, DecidedBy decidedBy
    );
    event DecisionRecorded(
        bytes32 indexed invoiceHash, uint8 outcome, bytes32 reasonHash, bytes32 evidenceHash, DecidedBy decidedBy
    );
    event Swept(uint256 returned);

    IERC20 public immutable usdc;
    /// The template's own address: calls on the template (which has no clone data) are refused.
    address private immutable _template;

    uint256 public spent;
    bool public closed;
    mapping(bytes32 invoiceHash => bool) public paid;

    constructor(IERC20 usdc_) EIP712("Countersign Vault", "1") {
        usdc = usdc_;
        _template = address(this);
    }

    modifier onlyClone() {
        if (address(this) == _template) revert NotAVault();
        _;
    }

    // ---------- fixed data ----------

    function _args()
        private
        view
        returns (address account_, bytes32 supplierId_, bytes32 orderHash_, uint64 expiry_, uint256 amount_)
    {
        return abi.decode(Clones.fetchCloneArgs(address(this)), (address, bytes32, bytes32, uint64, uint256));
    }

    function account() public view onlyClone returns (address a) {
        (a,,,,) = _args();
    }

    function supplierId() external view onlyClone returns (bytes32 s) {
        (, s,,,) = _args();
    }

    function orderHash() external view onlyClone returns (bytes32 h) {
        (,, h,,) = _args();
    }

    function expiry() external view onlyClone returns (uint64 e) {
        (,,, e,) = _args();
    }

    function amount() external view onlyClone returns (uint256 a) {
        (,,,, a) = _args();
    }

    function remaining() external view onlyClone returns (uint256) {
        (,,,, uint256 funded) = _args();
        return funded - spent;
    }

    function paymentDigest(Payment calldata p) external view returns (bytes32) {
        return _hashTypedDataV4(PaymentRules.hashPayment(p));
    }

    function decisionDigest(Decision calldata d) external view returns (bytes32) {
        return _hashTypedDataV4(PaymentRules.hashDecision(d));
    }

    // ---------- payments ----------

    /// @notice Pays an invoice released by the agent and the checker. Anyone may send it;
    /// the signatures carry the authority.
    function pay(Payment calldata p, bytes calldata agentSig, bytes calldata checkerSig) external onlyClone {
        (address acct, bytes32 sid,, uint64 exp, uint256 funded) = _args();
        PaymentContext memory ctx = ICountersignAccount(acct).paymentContext(sid);
        if (ctx.agentKey == address(0) || ctx.checkerKey == address(0)) revert PolicyNotSet();
        if (block.timestamp > ctx.policyExpiry) revert PolicyExpired();
        PaymentRules.check(p, ctx, VaultState(funded, spent, exp, closed, paid[p.invoiceHash]));
        bytes32 digest = _hashTypedDataV4(PaymentRules.hashPayment(p));
        if (!_signedBy(digest, agentSig, ctx.agentKey)) revert InvalidAgentSignature();
        if (!_signedBy(digest, checkerSig, ctx.checkerKey)) revert InvalidCheckerSignature();
        _execute(p, funded, DecidedBy.Checker);
    }

    /// @notice Pays a held payment with the owner's passkey. The same rules apply: the
    /// address on file, its waiting period, the caps, what is left, and once per invoice.
    function payWithOwner(Payment calldata p, WebAuthn.WebAuthnAuth calldata auth) external onlyClone {
        (address acct, bytes32 sid,, uint64 exp, uint256 funded) = _args();
        PaymentContext memory ctx = ICountersignAccount(acct).paymentContext(sid);
        PaymentRules.check(p, ctx, VaultState(funded, spent, exp, closed, paid[p.invoiceHash]));
        bytes32 digest = _hashTypedDataV4(PaymentRules.hashPayment(p));
        if (!OwnerAuth.verify(digest, auth, ctx.ownerQx, ctx.ownerQy)) revert InvalidOwnerSignature();
        _execute(p, funded, DecidedBy.Owner);
    }

    function _execute(Payment calldata p, uint256 funded, DecidedBy by) private {
        paid[p.invoiceHash] = true;
        uint256 newSpent = spent + p.amount;
        spent = newSpent;
        usdc.safeTransfer(p.payTo, p.amount);
        emit PaymentExecuted(p.invoiceHash, p.payTo, p.amount, funded - newSpent, by);
    }

    function _signedBy(bytes32 digest, bytes calldata sig, address expected) private pure returns (bool) {
        // tryRecover refuses malleable (high-s) signatures and never reverts on bad input.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
        return err == ECDSA.RecoverError.NoError && signer == expected;
    }

    // ---------- decisions (events only) ----------

    /// @notice Records the checker's held or blocked outcome, with its evidence hash. Writes
    /// no storage and moves no money.
    function recordDecision(Decision calldata d, bytes calldata checkerSig) external onlyClone {
        _validOutcome(d.outcome);
        (address acct, bytes32 sid,,,) = _args();
        PaymentContext memory ctx = ICountersignAccount(acct).paymentContext(sid);
        if (!_signedBy(_hashTypedDataV4(PaymentRules.hashDecision(d)), checkerSig, ctx.checkerKey)) {
            revert InvalidCheckerSignature();
        }
        emit DecisionRecorded(d.invoiceHash, d.outcome, d.reasonHash, d.evidenceHash, DecidedBy.Checker);
    }

    /// @notice Records the owner's decision (typically a refusal) with their passkey.
    function recordDecisionByOwner(Decision calldata d, WebAuthn.WebAuthnAuth calldata auth) external onlyClone {
        _validOutcome(d.outcome);
        (address acct, bytes32 sid,,,) = _args();
        PaymentContext memory ctx = ICountersignAccount(acct).paymentContext(sid);
        if (!OwnerAuth.verify(_hashTypedDataV4(PaymentRules.hashDecision(d)), auth, ctx.ownerQx, ctx.ownerQy)) {
            revert InvalidOwnerSignature();
        }
        emit DecisionRecorded(d.invoiceHash, d.outcome, d.reasonHash, d.evidenceHash, DecidedBy.Owner);
    }

    function _validOutcome(uint8 outcome) private pure {
        if (outcome < OUTCOME_HELD || outcome > OUTCOME_BLOCKED) revert InvalidOutcome();
    }

    // ---------- closing ----------

    /// @inheritdoc IOrderVault
    function close() external onlyClone returns (uint256 returned) {
        address acct = account();
        if (msg.sender != acct) revert NotAccount();
        returned = _closeTo(acct);
    }

    /// @notice After the order expires, anyone can return what is left to the account. It
    /// can go nowhere else.
    function sweep() external onlyClone returns (uint256 returned) {
        (address acct,,, uint64 exp,) = _args();
        if (closed) revert VaultClosed();
        if (block.timestamp <= exp) revert NotExpired();
        returned = _closeTo(acct);
        emit Swept(returned);
    }

    function _closeTo(address acct) private returns (uint256 returned) {
        if (closed) revert VaultClosed();
        closed = true;
        returned = usdc.balanceOf(address(this));
        if (returned > 0) usdc.safeTransfer(acct, returned);
    }
}
