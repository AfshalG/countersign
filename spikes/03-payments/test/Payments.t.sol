// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin-contracts/token/ERC20/ERC20.sol";
import {OrderVault} from "../src/OrderVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {SharedAccount} from "../src/SharedAccount.sol";

/// 6-decimal stand-in for USDC in local tests; the testnet runs use Circle's USDC.
contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PaymentsTest is Test {
    TestUSDC usdc;
    VaultFactory factory;
    SharedAccount account;
    address checker;
    uint256 checkerKey;
    address supplier = makeAddr("supplier");

    function setUp() public {
        usdc = new TestUSDC();
        (checker, checkerKey) = makeAddrAndKey("checker");
        factory = new VaultFactory(usdc, checker);
        account = new SharedAccount(usdc, checker);
        usdc.mint(address(this), 1_000_000);
        usdc.approve(address(factory), type(uint256).max);
    }

    function sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(checkerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function openVault(uint256 amount, bytes32 salt) internal returns (OrderVault) {
        return OrderVault(factory.openOrder(supplier, amount, salt));
    }

    // --- Vaults ---

    function test_FactoryCreatesAndFundsAVault() public {
        OrderVault vault = openVault(5_000, "order-1");
        assertEq(usdc.balanceOf(address(vault)), 5_000);
        assertEq(vault.supplier(), supplier);
        assertEq(vault.checker(), checker);
        assertEq(address(vault.token()), address(usdc));
        assertEq(address(vault), factory.predictVault(supplier, "order-1"));
    }

    function test_VaultPaysWithTheCheckersSignature() public {
        OrderVault vault = openVault(5_000, "order-1");
        vault.pay("invoice-1", 1_000, sign(vault.paymentDigest("invoice-1", 1_000)));
        assertEq(usdc.balanceOf(supplier), 1_000);
        assertEq(usdc.balanceOf(address(vault)), 4_000);
        assertTrue(vault.paid("invoice-1"));
    }

    function test_VaultRefusesTheSameInvoiceTwice() public {
        OrderVault vault = openVault(5_000, "order-1");
        bytes memory sig = sign(vault.paymentDigest("invoice-1", 1_000));
        vault.pay("invoice-1", 1_000, sig);
        vm.expectRevert(OrderVault.AlreadyPaid.selector);
        vault.pay("invoice-1", 1_000, sig);
    }

    function test_VaultRefusesAnotherSigner() public {
        OrderVault vault = openVault(5_000, "order-1");
        (, uint256 otherKey) = makeAddrAndKey("not the checker");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherKey, vault.paymentDigest("invoice-1", 1_000));
        vm.expectRevert(OrderVault.NotTheChecker.selector);
        vault.pay("invoice-1", 1_000, abi.encodePacked(r, s, v));
    }

    function test_VaultRefusesASignatureForAnotherVault() public {
        OrderVault a = openVault(5_000, "order-a");
        OrderVault b = openVault(5_000, "order-b");
        bytes memory sigForA = sign(a.paymentDigest("invoice-1", 1_000));
        vm.expectRevert(OrderVault.NotTheChecker.selector);
        b.pay("invoice-1", 1_000, sigForA);
    }

    function test_VaultRefusesMoreThanItHolds() public {
        OrderVault vault = openVault(500, "order-1");
        bytes memory sig = sign(vault.paymentDigest("invoice-1", 1_000));
        vm.expectRevert(OrderVault.InsufficientFunds.selector);
        vault.pay("invoice-1", 1_000, sig);
    }

    function test_VaultRefusesASignatureForAnotherInvoice() public {
        OrderVault vault = openVault(5_000, "order-1");
        bytes memory sigForInvoice1 = sign(vault.paymentDigest("invoice-1", 1_000));
        vm.expectRevert(OrderVault.NotTheChecker.selector);
        vault.pay("invoice-2", 1_000, sigForInvoice1);
    }

    function test_VaultRefusesASignatureForAnotherChain() public {
        OrderVault vault = openVault(5_000, "order-1");
        bytes memory sig = sign(vault.paymentDigest("invoice-1", 1_000));
        vm.chainId(143); // the same vault address on mainnet must not accept a testnet signature
        vm.expectRevert(OrderVault.NotTheChecker.selector);
        vault.pay("invoice-1", 1_000, sig);
    }

    function test_ImplementationItselfCannotPay() public {
        OrderVault implementation = OrderVault(factory.implementation());
        vm.expectRevert();
        implementation.pay("invoice-1", 1_000, sign(bytes32(uint256(1))));
    }

    /// Whatever amount the checker signs, a vault never pays more than it was funded with,
    /// and the supplier receives exactly what was signed or nothing.
    function testFuzz_VaultNeverMovesMoreThanTheOrderHolds(uint96 funded, uint96 amount) public {
        funded = uint96(bound(funded, 0, 1_000_000));
        OrderVault vault = openVault(funded, "order-1");
        bytes memory sig = sign(vault.paymentDigest("invoice-1", amount));
        if (amount > funded) {
            vm.expectRevert(OrderVault.InsufficientFunds.selector);
            vault.pay("invoice-1", amount, sig);
            assertEq(usdc.balanceOf(supplier), 0);
        } else {
            vault.pay("invoice-1", amount, sig);
            assertEq(usdc.balanceOf(supplier), amount);
            assertEq(usdc.balanceOf(address(vault)), funded - amount);
        }
    }

    function testFuzz_VaultNeverPaysWithoutTheChecker(uint256 key, bytes32 invoice, uint96 amount) public {
        key = bound(key, 1, type(uint128).max);
        vm.assume(vm.addr(key) != checker);
        OrderVault vault = openVault(5_000, "order-1");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.paymentDigest(invoice, amount));
        vm.expectRevert(OrderVault.NotTheChecker.selector);
        vault.pay(invoice, amount, abi.encodePacked(r, s, v));
    }

    function test_OpeningManyVaultsAtOnce() public {
        address[] memory suppliers = new address[](3);
        bytes32[] memory salts = new bytes32[](3);
        for (uint256 i; i < 3; i++) {
            suppliers[i] = makeAddr(string(abi.encode(i)));
            salts[i] = bytes32(i + 1);
        }
        address[] memory vaults = factory.openOrders(suppliers, 1_000, salts);
        for (uint256 i; i < 3; i++) {
            assertEq(usdc.balanceOf(vaults[i]), 1_000);
            assertEq(OrderVault(vaults[i]).supplier(), suppliers[i]);
        }
    }

    // --- One account ---

    function fundAccount(uint256 orderId, uint256 amount) internal {
        account.setOrder(orderId, supplier, amount);
        require(usdc.transfer(address(account), amount));
    }

    function test_AccountPaysWithTheCheckersSignature() public {
        fundAccount(1, 5_000);
        account.pay(1, "invoice-1", 1_000, sign(account.paymentDigest(1, "invoice-1", 1_000)));
        assertEq(usdc.balanceOf(supplier), 1_000);
        assertTrue(account.paid(1, "invoice-1"));
    }

    function test_AccountRefusesTheSameInvoiceTwice() public {
        fundAccount(1, 5_000);
        bytes memory sig = sign(account.paymentDigest(1, "invoice-1", 1_000));
        account.pay(1, "invoice-1", 1_000, sig);
        vm.expectRevert(SharedAccount.AlreadyPaid.selector);
        account.pay(1, "invoice-1", 1_000, sig);
    }

    function test_AccountRefusesAnotherSignerAndAnotherOrder() public {
        fundAccount(1, 5_000);
        account.setOrder(2, makeAddr("other supplier"), 5_000);
        bytes memory sigForOrder1 = sign(account.paymentDigest(1, "invoice-1", 1_000));
        vm.expectRevert(SharedAccount.NotTheChecker.selector);
        account.pay(2, "invoice-1", 1_000, sigForOrder1);
    }

    function test_AccountRefusesMoreThanTheOrdersBudget() public {
        fundAccount(1, 500);
        require(usdc.transfer(address(account), 10_000)); // money for other orders must not leak
        bytes memory sig = sign(account.paymentDigest(1, "invoice-1", 1_000));
        vm.expectRevert(SharedAccount.InsufficientFunds.selector);
        account.pay(1, "invoice-1", 1_000, sig);
    }

    function test_AccountRefusesAnUnknownOrder() public {
        bytes memory sig = sign(account.paymentDigest(9, "invoice-1", 1_000));
        vm.expectRevert(SharedAccount.UnknownOrder.selector);
        account.pay(9, "invoice-1", 1_000, sig);
    }

    function test_AccountRefusesAnotherSigner() public {
        fundAccount(1, 5_000);
        (, uint256 otherKey) = makeAddrAndKey("not the checker");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherKey, account.paymentDigest(1, "invoice-1", 1_000));
        vm.expectRevert(SharedAccount.NotTheChecker.selector);
        account.pay(1, "invoice-1", 1_000, abi.encodePacked(r, s, v));
    }

    function test_AccountRefusesASignatureForAnotherChain() public {
        fundAccount(1, 5_000);
        bytes memory sig = sign(account.paymentDigest(1, "invoice-1", 1_000));
        vm.chainId(143);
        vm.expectRevert(SharedAccount.NotTheChecker.selector);
        account.pay(1, "invoice-1", 1_000, sig);
    }

    function test_OnlyTheOwnerSetsOrders() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(SharedAccount.NotOwner.selector);
        account.setOrder(1, supplier, 5_000);
    }

    /// One order can never spend another order's money, even though it all sits in one account.
    function testFuzz_AccountNeverMovesMoreThanTheOrdersBudget(uint96 budget, uint96 amount) public {
        budget = uint96(bound(budget, 0, 100_000));
        fundAccount(1, budget);
        fundAccount(2, 500_000); // another order's money in the same account
        bytes memory sig = sign(account.paymentDigest(1, "invoice-1", amount));
        if (amount > budget) {
            vm.expectRevert(SharedAccount.InsufficientFunds.selector);
            account.pay(1, "invoice-1", amount, sig);
            assertEq(usdc.balanceOf(supplier), 0);
        } else {
            account.pay(1, "invoice-1", amount, sig);
            assertEq(usdc.balanceOf(supplier), amount);
            assertEq(account.budget(1), budget - amount);
            assertEq(account.budget(2), 500_000);
        }
    }

    // --- Gas, for the hard-coded limits ---

    function test_Gas() public {
        uint256 g = gasleft();
        OrderVault vault = openVault(5_000, "gas-order");
        emit log_named_uint("open one vault (create + fund)", g - gasleft());
        bytes memory sig = sign(vault.paymentDigest("gas-invoice", 1_000));
        g = gasleft();
        vault.pay("gas-invoice", 1_000, sig);
        emit log_named_uint("vault payment", g - gasleft());
        fundAccount(7, 5_000);
        sig = sign(account.paymentDigest(7, "gas-invoice", 1_000));
        g = gasleft();
        account.pay(7, "gas-invoice", 1_000, sig);
        emit log_named_uint("account payment", g - gasleft());
    }
}
