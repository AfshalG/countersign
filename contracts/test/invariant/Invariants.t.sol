// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {Base} from "../helpers/Base.sol";
import {PasskeySigner} from "../helpers/PasskeySigner.sol";
import {TestUSDC} from "../helpers/TestUSDC.sol";
import {CountersignAccount} from "../../src/CountersignAccount.sol";
import {OrderVault} from "../../src/OrderVault.sol";
import {OwnerAuth} from "../../src/libraries/OwnerAuth.sol";
import {Payment, Policy, OwnerSig} from "../../src/CountersignTypes.sol";

/// @notice Drives random sequences of everything an account and its vaults can do, and keeps
/// ghost totals of what should have happened. Reverts are expected (most random actions are
/// refused); the invariants check the state that results.
contract Handler is Test {
    CountersignAccount public immutable account;
    TestUSDC public immutable usdc;
    uint256 immutable ownerPk;
    uint256 immutable agentPk;
    uint256 immutable checkerPk;
    bytes32 immutable supplierId;
    uint256 immutable cap;
    uint256 immutable newCap;

    address public immutable attacker = makeAddr("attacker wallet, never on file");
    address public immutable treasury = makeAddr("company treasury");
    address[3] public wallets =
        [makeAddr("supplier wallet 1"), makeAddr("supplier wallet 2"), makeAddr("supplier wallet 3")];
    address public currentPayTo;

    OrderVault[] public vaults;
    bytes32[] public orderIds;
    mapping(address vault => bytes32) public lastInvoice;
    mapping(address vault => mapping(bytes32 invoice => uint256)) public paidCount;
    mapping(address vault => uint256) public paidOut;

    uint256 public deposited;
    uint256 public totalPaid;
    uint256 public totalWithdrawn;
    uint256 public paidWhilePaused;
    uint256 public doublePaid;
    uint256 internal counter;

    /// Activity counters, so a passing run can be shown to have done something.
    uint256 public paysOk;
    uint256 public ownerPaysOk;
    uint256 public reuseAttempts;
    uint256 public attackerAttempts;
    uint256 public pausedAttempts;
    uint256 public closesOk;
    uint256 public sweepsOk;

    constructor(
        CountersignAccount account_,
        TestUSDC usdc_,
        uint256[3] memory keys, // owner, agent, checker
        bytes32 supplierId_,
        uint256[2] memory caps, // per-payment cap, new-address cap
        uint256 deposited_
    ) {
        account = account_;
        usdc = usdc_;
        ownerPk = keys[0];
        agentPk = keys[1];
        checkerPk = keys[2];
        supplierId = supplierId_;
        cap = caps[0];
        newCap = caps[1];
        deposited = deposited_;
        currentPayTo = wallets[0];
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function _deadline() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp() + 1 hours);
    }

    function _owner(bytes32 structHash) internal view returns (OwnerSig[] memory) {
        return PasskeySigner.one(ownerPk, account.ownerDigest(structHash));
    }

    /// Half the amounts fit under the new-address cap, so payments to a fresh address succeed too.
    function _amount(uint256 seed) internal view returns (uint256) {
        return seed % 2 == 0 ? bound(seed, 1, newCap) : bound(seed, 1, cap);
    }

    function _pick(uint256 seed) internal view returns (OrderVault, bytes32) {
        uint256 i = seed % vaults.length;
        return (vaults[i], orderIds[i]);
    }

    // ---------- actions ----------

    function approveOrder(uint256 amountSeed, uint256 daysSeed) external {
        uint256 available = usdc.balanceOf(address(account));
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 1, available);
        uint64 expiry = uint64(vm.getBlockTimestamp() + bound(daysSeed, 1, 60) * 1 days);
        bytes32 orderId = keccak256(abi.encode("order", ++counter));
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        OwnerSig[] memory auth =
            _owner(OwnerAuth.approveOrderHash(orderId, supplierId, bytes32(0), amount, expiry, n, dl));
        try account.approveOrder(orderId, supplierId, bytes32(0), amount, expiry, n, dl, auth) returns (address v) {
            vaults.push(OrderVault(v));
            orderIds.push(orderId);
        } catch {}
    }

    function pay(uint256 vaultSeed, uint256 amountSeed, bool reuseInvoice, bool toAttacker) external {
        if (vaults.length == 0) return;
        (OrderVault vault,) = _pick(vaultSeed);
        bytes32 invoice = reuseInvoice && lastInvoice[address(vault)] != 0
            ? lastInvoice[address(vault)]
            : keccak256(abi.encode("invoice", ++counter));
        Payment memory p = Payment({
            amount: _amount(amountSeed),
            invoiceHash: invoice,
            payTo: toAttacker ? attacker : currentPayTo,
            deadline: _deadline()
        });
        bytes32 digest = vault.paymentDigest(p);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(agentPk, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(checkerPk, digest);
        bool wasPaused = account.paused();
        if (reuseInvoice) reuseAttempts++;
        if (toAttacker) attackerAttempts++;
        if (wasPaused) pausedAttempts++;
        try vault.pay(p, abi.encodePacked(r1, s1, v1), abi.encodePacked(r2, s2, v2)) {
            paysOk++;
            _recordPaid(vault, p, wasPaused);
        } catch {}
    }

    function payWithOwner(uint256 vaultSeed, uint256 amountSeed, bool reuseInvoice) external {
        if (vaults.length == 0) return;
        (OrderVault vault,) = _pick(vaultSeed);
        bytes32 invoice = reuseInvoice && lastInvoice[address(vault)] != 0
            ? lastInvoice[address(vault)]
            : keccak256(abi.encode("held invoice", ++counter));
        Payment memory p =
            Payment({amount: _amount(amountSeed), invoiceHash: invoice, payTo: currentPayTo, deadline: _deadline()});
        OwnerSig[] memory auth = PasskeySigner.one(ownerPk, vault.paymentDigest(p));
        bool wasPaused = account.paused();
        if (wasPaused) pausedAttempts++;
        try vault.payWithOwner(p, auth) {
            ownerPaysOk++;
            _recordPaid(vault, p, wasPaused);
        } catch {}
    }

    function _recordPaid(OrderVault vault, Payment memory p, bool wasPaused) internal {
        if (wasPaused) paidWhilePaused++;
        if (++paidCount[address(vault)][p.invoiceHash] > 1) doublePaid++;
        lastInvoice[address(vault)] = p.invoiceHash;
        paidOut[address(vault)] += p.amount;
        totalPaid += p.amount;
    }

    function changeAddress(uint256 seed) external {
        address next = wallets[seed % 3];
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        OwnerSig[] memory auth = _owner(OwnerAuth.setSupplierHash(supplierId, next, true, 0, n, dl));
        try account.setSupplier(supplierId, next, true, 0, n, dl, auth) {
            currentPayTo = next;
        } catch {}
    }

    function closeOrder(uint256 vaultSeed) external {
        if (vaults.length == 0) return;
        (, bytes32 orderId) = _pick(vaultSeed);
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        OwnerSig[] memory auth = _owner(OwnerAuth.closeOrderHash(orderId, n, dl));
        try account.closeOrder(orderId, n, dl, auth) {
            closesOk++;
        } catch {}
    }

    function sweep(uint256 vaultSeed) external {
        if (vaults.length == 0) return;
        (OrderVault vault,) = _pick(vaultSeed);
        try vault.sweep() {
            sweepsOk++;
        } catch {}
    }

    function withdraw(uint256 amountSeed) external {
        uint256 available = usdc.balanceOf(address(account));
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 1, available);
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        OwnerSig[] memory auth = _owner(OwnerAuth.withdrawHash(treasury, amount, n, dl));
        try account.withdraw(treasury, amount, n, dl, auth) {
            totalWithdrawn += amount;
        } catch {}
    }

    function togglePause() external {
        uint256 n = account.ownerNonce();
        uint64 dl = _deadline();
        if (account.paused()) {
            OwnerSig[] memory auth = _owner(OwnerAuth.unpauseHash(n, dl));
            try account.unpause(n, dl, auth) {} catch {}
        } else {
            OwnerSig[] memory auth = _owner(OwnerAuth.pauseHash(n, dl));
            try account.pause(n, dl, auth) {} catch {}
        }
    }

    function deposit(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 1_000_000);
        usdc.mint(address(account), amount);
        deposited += amount;
    }

    function warp(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1, 3 days));
    }
}

contract InvariantsTest is Base {
    Handler handler;

    function setUp() public override {
        super.setUp();
        _setPolicy(
            _withExpiry(defaultPolicy(), uint64(vm.getBlockTimestamp() + 3650 days)) // ten years: warps never end it
        );
        handler = new Handler(account, usdc, [OWNER_PK, agentPk, checkerPk], SUPPLIER, [uint256(CAP), NEW_CAP], FUNDS);
        _setSupplier(SUPPLIER, handler.currentPayTo(), true);
        vm.warp(vm.getBlockTimestamp() + WAIT);
        targetContract(address(handler));
    }

    function _withExpiry(Policy memory p, uint64 expiry) internal pure returns (Policy memory) {
        p.expiry = expiry;
        return p;
    }

    function test_TheHandlerCanPayAndDoublePayIsCaught() public {
        handler.approveOrder(500_000, 10);
        assertEq(handler.vaultCount(), 1);
        handler.pay(0, 5_000, false, false);
        assertEq(handler.paysOk(), 1);
        handler.pay(0, 5_000, true, false); // same invoice again: refused
        assertEq(handler.paysOk(), 1);
        handler.payWithOwner(0, 5_000, false);
        assertEq(handler.ownerPaysOk(), 1);
        handler.pay(0, 5_000, false, true); // to an address never on file: refused
        assertEq(handler.paysOk(), 1);
    }

    /// A fixed pseudo-random session of 400 actions: it must actually move money (so the
    /// invariants are not passing on runs where nothing happens) and keep every rule.
    function test_ARandomSessionMovesMoneyAndKeepsEveryRule() public {
        for (uint256 i; i < 400; i++) {
            uint256 r = uint256(keccak256(abi.encode("session", i)));
            uint256 action = r % 20;
            if (action < 3) handler.approveOrder(r >> 8, r >> 16);
            else if (action < 10) handler.pay(r >> 8, r >> 16, (r >> 24) % 4 == 0, (r >> 32) % 6 == 0);
            else if (action < 12) handler.payWithOwner(r >> 8, r >> 16, (r >> 24) % 4 == 0);
            else if (action == 12) handler.changeAddress(r >> 8);
            else if (action == 13) handler.closeOrder(r >> 8);
            else if (action == 14) handler.sweep(r >> 8);
            else if (action == 15) handler.withdraw(r >> 8);
            else if (action == 16) handler.togglePause();
            else if (action == 17) handler.deposit(r >> 8);
            else handler.warp(r >> 8);
        }
        assertGt(handler.paysOk(), 0, "no agent and checker payment succeeded");
        assertGt(handler.ownerPaysOk(), 0, "no owner payment succeeded");
        assertGt(handler.reuseAttempts(), 0);
        assertGt(handler.attackerAttempts(), 0);
        assertGt(handler.pausedAttempts(), 0);
        assertGt(handler.closesOk() + handler.sweepsOk(), 0);
        invariant_MoneyGoesOnlyToAddressesOnFile();
        invariant_AVaultNeverPaysMoreThanItsOrder();
        invariant_NothingIsPaidWhilePaused();
        invariant_NoInvoiceIsPaidTwice();
        invariant_EveryUnitIsAccountedFor();
        console.log(
            string.concat(
                "session: ",
                vm.toString(handler.vaultCount()),
                " orders, ",
                vm.toString(handler.paysOk()),
                " agent+checker payments, ",
                vm.toString(handler.ownerPaysOk()),
                " owner payments, ",
                vm.toString(handler.closesOk()),
                " closed, ",
                vm.toString(handler.sweepsOk()),
                " swept"
            )
        );
    }

    function afterInvariant() public view {
        console.log(
            string.concat(
                "vaults ",
                vm.toString(handler.vaultCount()),
                ", paid ",
                vm.toString(handler.paysOk()),
                " + by owner ",
                vm.toString(handler.ownerPaysOk()),
                ", reused-invoice tries ",
                vm.toString(handler.reuseAttempts()),
                ", wrong-address tries ",
                vm.toString(handler.attackerAttempts())
            )
        );
        console.log(
            string.concat(
                "paused tries ",
                vm.toString(handler.pausedAttempts()),
                ", closed ",
                vm.toString(handler.closesOk()),
                ", swept ",
                vm.toString(handler.sweepsOk()),
                ", total paid ",
                vm.toString(handler.totalPaid())
            )
        );
    }

    /// 1. Money leaves a vault only to an address that was the supplier's on file, or back to
    /// the account: an address that was never on file holds nothing, and the wallets that were
    /// on file hold exactly what was paid.
    function invariant_MoneyGoesOnlyToAddressesOnFile() public view {
        assertEq(usdc.balanceOf(handler.attacker()), 0);
        uint256 onFile;
        for (uint256 i; i < 3; i++) {
            onFile += usdc.balanceOf(handler.wallets(i));
        }
        assertEq(onFile, handler.totalPaid());
        assertEq(usdc.balanceOf(handler.treasury()), handler.totalWithdrawn());
    }

    /// 2. A vault never pays out more than it was funded with.
    function invariant_AVaultNeverPaysMoreThanItsOrder() public view {
        for (uint256 i; i < handler.vaultCount(); i++) {
            OrderVault v = handler.vaults(i);
            assertLe(v.spent(), v.amount());
            assertEq(v.spent(), handler.paidOut(address(v)));
        }
    }

    /// 3. While paused, no vault pays.
    function invariant_NothingIsPaidWhilePaused() public view {
        assertEq(handler.paidWhilePaused(), 0);
    }

    /// 4. No invoice is paid twice by one vault.
    function invariant_NoInvoiceIsPaidTwice() public view {
        assertEq(handler.doublePaid(), 0);
    }

    /// 5. Account + vaults + paid out + withdrawn = everything deposited.
    function invariant_EveryUnitIsAccountedFor() public view {
        uint256 held = usdc.balanceOf(address(account));
        for (uint256 i; i < handler.vaultCount(); i++) {
            held += usdc.balanceOf(address(handler.vaults(i)));
        }
        assertEq(held + handler.totalPaid() + handler.totalWithdrawn(), handler.deposited());
    }
}
