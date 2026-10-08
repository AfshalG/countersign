// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {WebAuthn} from "@openzeppelin-contracts/utils/cryptography/WebAuthn.sol";
import {AccountFactory} from "../src/AccountFactory.sol";
import {CountersignAccount} from "../src/CountersignAccount.sol";
import {OrderVault} from "../src/OrderVault.sol";
import {OwnerAuth} from "../src/libraries/OwnerAuth.sol";
import {Policy, Payment, Decision, OUTCOME_HELD, OwnerSig} from "../src/CountersignTypes.sol";
import "../src/CountersignErrors.sol";
import {PasskeySigner} from "../test/helpers/PasskeySigner.sol";

/// @notice Slice 5's manual test on Monad testnet, one step per function, run in order:
///
///   forge script script/Slice05Testnet.s.sol --sig "deploy()"       --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///   forge script script/Slice05Testnet.s.sol --sig "setUpAccount()" --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///   (wait two minutes: the supplier's waiting period)
///   forge script script/Slice05Testnet.s.sol --sig "payAndRefuse()" --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///   forge script script/Slice05Testnet.s.sol --sig "payHeld()"      --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///
/// The owner is a software passkey (SLICE5_OWNER_P256_KEY), signing real WebAuthn
/// assertions as in the tests; the phone's passkey is used separately for the held payment.
/// Every "must refuse" check is a simulation against live testnet state: nothing is sent,
/// so a refusal costs no MON. Gas limits are the node's estimate plus 8% (fees are charged
/// on the limit on Monad).
contract Slice05Testnet is Script {
    IERC20 constant USDC = IERC20(0x534b2f3A21130d7a60830c2Df862319e593943A3);
    /// The demo supplier from Slice 2; its website publishes this address.
    address constant KALIBRE = 0x90f9931B748B26763161a8191C178Fe425C25fEc;
    bytes32 constant SUPPLIER = keccak256("kalibre-studio");
    bytes32 constant ORDER = keccak256("testnet order 2026-001");
    bytes32 constant ORDER_HASH = keccak256("purchase order 2026-001, PDF");
    bytes32 constant SALT = bytes32("slice 5 testnet");
    uint64 constant WAIT = 120; // two minutes, for this test only (default 48 hours)
    string constant DEPLOYMENTS = "deployments/10143.json";

    uint256 deployerKey;
    uint256 ownerP256;
    uint256 agentKey;
    uint256 checkerKey;

    function _keys() internal {
        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        ownerP256 = vm.envUint("SLICE5_OWNER_P256_KEY");
        agentKey = vm.envUint("SLICE5_AGENT_PRIVATE_KEY");
        checkerKey = vm.envUint("SLICE5_CHECKER_PRIVATE_KEY");
    }

    function _factory() internal view returns (AccountFactory) {
        return AccountFactory(vm.parseJsonAddress(vm.readFile(DEPLOYMENTS), ".factory"));
    }

    function _account() internal view returns (CountersignAccount) {
        (bytes32 qx, bytes32 qy) = PasskeySigner.publicKey(ownerP256);
        return CountersignAccount(_factory().predictAccount(qx, qy, WAIT, SALT));
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 1 hours);
    }

    function _owner(CountersignAccount account, bytes32 structHash) internal view returns (OwnerSig[] memory) {
        return PasskeySigner.one(ownerP256, account.ownerDigest(structHash));
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _payment(uint256 amount, bytes32 invoice, address payTo) internal view returns (Payment memory) {
        return Payment({amount: amount, invoiceHash: invoice, payTo: payTo, deadline: _deadline()});
    }

    /// Simulated only (outside any broadcast): the call must revert with exactly `err`.
    function _mustRefuse(address target, bytes memory data, bytes4 err, string memory what) internal {
        (bool ok, bytes memory ret) = target.call(data);
        require(!ok, string.concat(what, ": was NOT refused"));
        require(ret.length >= 4 && bytes4(ret) == err, string.concat(what, ": refused with a different error"));
        console.log(string.concat("refused as expected: ", what));
    }

    // ---------- step 1 ----------

    function deploy() external {
        _keys();
        vm.startBroadcast(deployerKey);
        AccountFactory factory = new AccountFactory(USDC);
        vm.stopBroadcast();
        string memory obj = "deployments";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "accountTemplate", factory.accountTemplate());
        vm.serializeAddress(obj, "vaultTemplate", factory.vaultTemplate());
        vm.writeJson(vm.serializeAddress(obj, "factory", address(factory)), DEPLOYMENTS);
        console.log("AccountFactory", address(factory));
        console.log("CountersignAccount template", factory.accountTemplate());
        console.log("OrderVault template", factory.vaultTemplate());
    }

    // ---------- step 2 ----------

    function setUpAccount() external {
        _keys();
        AccountFactory factory = _factory();
        (bytes32 qx, bytes32 qy) = PasskeySigner.publicKey(ownerP256);
        CountersignAccount account = _account();

        vm.startBroadcast(deployerKey);
        factory.createAccount(qx, qy, WAIT, SALT);
        require(USDC.transfer(address(account), 10_000), "fund"); // 0.01 USDC
        vm.stopBroadcast();

        Policy memory p = Policy({
            agentKey: vm.addr(agentKey),
            checkerKey: vm.addr(checkerKey),
            perPaymentCap: 5_000, // 0.005 USDC
            newAddressCap: 2_000, // 0.002 USDC while the address is new
            newAddressPeriod: 7 days,
            waitingPeriod: WAIT,
            expiry: uint64(block.timestamp + 30 days)
        });
        uint64 dl = _deadline();
        OwnerSig[] memory a1 = _owner(account, OwnerAuth.setPolicyHash(p, 0, dl));
        OwnerSig[] memory a2 = _owner(account, OwnerAuth.setSupplierHash(SUPPLIER, KALIBRE, true, 0, 1, dl));
        uint64 expiry = uint64(block.timestamp + 30 days);
        OwnerSig[] memory a3 =
            _owner(account, OwnerAuth.approveOrderHash(ORDER, SUPPLIER, ORDER_HASH, 5_000, expiry, 2, dl));

        vm.startBroadcast(deployerKey);
        account.setPolicy(p, 0, dl, a1);
        account.setSupplier(SUPPLIER, KALIBRE, true, 0, 1, dl, a2);
        OrderVault vault = OrderVault(account.approveOrder(ORDER, SUPPLIER, ORDER_HASH, 5_000, expiry, 2, dl, a3));
        vm.stopBroadcast();

        // The supplier's address is inside its waiting period: a payment must be refused.
        Payment memory pay1 = _payment(1_000, keccak256("testnet invoice INV-0042"), KALIBRE);
        bytes32 digest = vault.paymentDigest(pay1);
        _mustRefuse(
            address(vault),
            abi.encodeCall(OrderVault.pay, (pay1, _sig(agentKey, digest), _sig(checkerKey, digest))),
            AddressNotYetActive.selector,
            "payment inside the waiting period (AddressNotYetActive)"
        );
        console.log("account", address(account));
        console.log("vault", address(vault));
        console.log("supplier can be paid from", account.supplier(SUPPLIER).activeAfter);
    }

    // ---------- step 3, after the waiting period ----------

    function payAndRefuse() external {
        _keys();
        CountersignAccount account = _account();
        OrderVault vault = OrderVault(account.vaultOf(ORDER));
        Payment memory pay1 = _payment(1_000, keccak256("testnet invoice INV-0042"), KALIBRE);
        bytes32 digest = vault.paymentDigest(pay1);
        bytes memory a = _sig(agentKey, digest);
        bytes memory c = _sig(checkerKey, digest);
        uint256 before = USDC.balanceOf(KALIBRE);

        vm.startBroadcast(deployerKey);
        vault.pay(pay1, a, c);
        vm.stopBroadcast();
        require(USDC.balanceOf(KALIBRE) == before + 1_000, "supplier not paid");
        console.log("paid 0.001 USDC to Kalibre Studio; left in the order:", vault.remaining());

        _mustRefuse(
            address(vault),
            abi.encodeCall(OrderVault.pay, (pay1, a, c)),
            AlreadyPaid.selector,
            "the same invoice again (AlreadyPaid)"
        );
        Payment memory lookAlike =
            _payment(1_000, keccak256("testnet invoice INV-0043"), 0x90f9931B748B26763161a8191c178fE425c25FeD);
        bytes32 d2 = vault.paymentDigest(lookAlike);
        _mustRefuse(
            address(vault),
            abi.encodeCall(OrderVault.pay, (lookAlike, _sig(agentKey, d2), _sig(checkerKey, d2))),
            PayToNotOnFile.selector,
            "a look-alike address (PayToNotOnFile)"
        );

        // Stop button: pause, a payment is refused, withdraw still works, unpause.
        uint64 dl = _deadline();
        uint256 n = account.ownerNonce();
        OwnerSig[] memory pauseAuth = _owner(account, OwnerAuth.pauseHash(n, dl));
        vm.startBroadcast(deployerKey);
        account.pause(n, dl, pauseAuth);
        vm.stopBroadcast();

        Payment memory pay3 = _payment(1_000, keccak256("testnet invoice INV-0044"), KALIBRE);
        bytes32 d3 = vault.paymentDigest(pay3);
        _mustRefuse(
            address(vault),
            abi.encodeCall(OrderVault.pay, (pay3, _sig(agentKey, d3), _sig(checkerKey, d3))),
            AccountPaused.selector,
            "a payment while paused (AccountPaused)"
        );

        address deployer = vm.addr(deployerKey);
        OwnerSig[] memory wAuth = _owner(account, OwnerAuth.withdrawHash(deployer, 1_000, n + 1, dl));
        OwnerSig[] memory uAuth = _owner(account, OwnerAuth.unpauseHash(n + 2, dl));
        vm.startBroadcast(deployerKey);
        account.withdraw(deployer, 1_000, n + 1, dl, wAuth);
        account.unpause(n + 2, dl, uAuth);
        vm.stopBroadcast();
        console.log("withdrew 0.001 USDC while paused, then unpaused");
        console.log("account USDC", USDC.balanceOf(address(account)), "vault USDC", USDC.balanceOf(address(vault)));
    }

    // ---------- Slice 6: an order for the gateway's testnet run ----------

    /// Funds the test account with 0.03 USDC and approves an order of that amount for Kalibre
    /// Studio, so the gateway can send up to 30 payments of 0.001 through it.
    function openGatewayOrder() external {
        _keys();
        CountersignAccount account = _account();
        bytes32 orderId = keccak256("gateway testnet order 2026-002");
        uint64 expiry = uint64(block.timestamp + 30 days);
        uint64 dl = _deadline();
        uint256 n = account.ownerNonce();
        OwnerSig[] memory auth = _owner(
            account,
            OwnerAuth.approveOrderHash(
                orderId, SUPPLIER, keccak256("purchase order 2026-002, PDF"), 30_000, expiry, n, dl
            )
        );
        vm.startBroadcast(deployerKey);
        require(USDC.transfer(address(account), 30_000), "fund");
        address vault = account.approveOrder(
            orderId, SUPPLIER, keccak256("purchase order 2026-002, PDF"), 30_000, expiry, n, dl, auth
        );
        vm.stopBroadcast();
        console.log("gateway order vault", vault);
    }

    // ---------- step 4: a held payment, paid once with the owner's passkey ----------

    function payHeld() external {
        _keys();
        CountersignAccount account = _account();
        OrderVault vault = OrderVault(account.vaultOf(ORDER));
        bytes32 invoice = keccak256("testnet invoice INV-0045, held: amount differs");

        // The checker records why it held the invoice (an event only; no money moves).
        Decision memory d = Decision({
            invoiceHash: invoice,
            outcome: OUTCOME_HELD,
            reasonHash: keccak256("amount differs from the order"),
            evidenceHash: keccak256("INV-0045.pdf")
        });
        bytes memory decisionSig = _sig(checkerKey, vault.decisionDigest(d));

        // The owner looks at it and pays it once with the passkey.
        Payment memory held = _payment(1_000, invoice, KALIBRE);
        OwnerSig[] memory auth = PasskeySigner.one(ownerP256, vault.paymentDigest(held));
        uint256 before = USDC.balanceOf(KALIBRE);

        vm.startBroadcast(deployerKey);
        vault.recordDecision(d, decisionSig);
        vault.payWithOwner(held, auth);
        vm.stopBroadcast();
        require(USDC.balanceOf(KALIBRE) == before + 1_000, "held payment not paid");
        console.log("held payment paid once with the owner's passkey; left in the order:", vault.remaining());

        _mustRefuse(
            address(vault),
            abi.encodeCall(OrderVault.payWithOwner, (held, auth)),
            AlreadyPaid.selector,
            "the same held payment again (AlreadyPaid)"
        );
        OwnerSig[] memory stranger = PasskeySigner.one(
            uint256(keccak256("not the owner")), vault.paymentDigest(_payment(1_000, keccak256("x"), KALIBRE))
        );
        _mustRefuse(
            address(vault),
            abi.encodeCall(OrderVault.payWithOwner, (_payment(1_000, keccak256("x"), KALIBRE), stranger)),
            InvalidOwnerSignature.selector,
            "another passkey (InvalidOwnerSignature)"
        );
    }
}
