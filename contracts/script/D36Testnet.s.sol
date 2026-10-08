// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {AccountFactory} from "../src/AccountFactory.sol";
import {CountersignAccount} from "../src/CountersignAccount.sol";
import {OrderVault} from "../src/OrderVault.sol";
import {OwnerAuth} from "../src/libraries/OwnerAuth.sol";
import {Policy, Payment, Decision, OUTCOME_HELD, OwnerKey, OwnerSig} from "../src/CountersignTypes.sol";
import "../src/CountersignErrors.sol";
import {PasskeySigner} from "../test/helpers/PasskeySigner.sol";

/// @notice D36 (several approvers) on Monad testnet, one step per function, run in order:
///
///   forge script script/D36Testnet.s.sol --sig "rehearse()"      --rpc-url monad_testnet   (simulated: nothing sent)
///   forge script script/D36Testnet.s.sol --sig "deploy()"        --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///   forge script script/D36Testnet.s.sol --sig "mainAccount()"   --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///   forge script script/D36Testnet.s.sol --sig "twoOwners()"     --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///   (wait two minutes: the supplier's waiting period)
///   forge script script/D36Testnet.s.sol --sig "twoOwnersPay()"  --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 108
///
/// `deploy` writes the new factory and templates to deployments/10143.json; Slice 5's are kept
/// in deployments/10143-slice5.json (accounts made on them stay as history). `mainAccount` makes
/// the hosted demo account again on the new factory with Slice 5's keys: the same owner passkey
/// (software), agent key (ERC-8004 agent 2066's wallet) and checker key, and the live policy.
/// `twoOwners` proves the thresholds on chain with a second account and a second software passkey.
/// Every "must refuse" check is a simulation against live testnet state: nothing is sent, so a
/// refusal costs no MON. Gas limits are the node's estimate plus 8% (fees are charged on the
/// limit on Monad).
contract D36Testnet is Script {
    IERC20 constant USDC = IERC20(0x534b2f3A21130d7a60830c2Df862319e593943A3);
    /// The demo supplier from Slice 2; its website publishes this address.
    address constant KALIBRE = 0x90f9931B748B26763161a8191C178Fe425C25fEc;
    bytes32 constant SUPPLIER = keccak256("kalibre-studio");
    bytes32 constant MAIN_SALT = bytes32("countersign demo d36");
    bytes32 constant TWO_SALT = bytes32("d36 two owners");
    bytes32 constant MAIN_ORDER = keccak256("demo order 2026-010");
    bytes32 constant TWO_ORDER = keccak256("d36 order 2026-011");
    uint64 constant WAIT = 120; // two minutes, as the live demo account (default 48 hours)
    uint256 constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    string constant DEPLOYMENTS = "deployments/10143.json";

    uint256 deployerKey;
    uint256 ownerP256;
    uint256 secondP256;
    uint256 agentKey;
    uint256 checkerKey;

    function _keys() internal {
        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        ownerP256 = vm.envUint("SLICE5_OWNER_P256_KEY");
        agentKey = vm.envUint("SLICE5_AGENT_PRIVATE_KEY");
        checkerKey = vm.envUint("SLICE5_CHECKER_PRIVATE_KEY");
        // A second owner's software passkey for this test only, derived from the first so no new
        // secret is needed; both are test keys the deployer already holds.
        secondP256 = uint256(keccak256(abi.encode(ownerP256, "d36 second owner"))) % (P256_N - 1) + 1;
    }

    function _factory() internal view returns (AccountFactory) {
        return AccountFactory(vm.parseJsonAddress(vm.readFile(DEPLOYMENTS), ".factory"));
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 1 hours);
    }

    function _key(uint256 pk) internal pure returns (OwnerKey memory k) {
        (k.qx, k.qy) = PasskeySigner.publicKey(pk);
    }

    /// Owner 0 alone.
    function _first(CountersignAccount account, bytes32 structHash) internal view returns (OwnerSig[] memory) {
        return PasskeySigner.one(ownerP256, account.ownerDigest(structHash));
    }

    /// Owner 1 alone.
    function _second(bytes32 digest) internal view returns (OwnerSig[] memory s) {
        s = new OwnerSig[](1);
        s[0] = OwnerSig({owner: 1, auth: PasskeySigner.sign(secondP256, digest)});
    }

    /// Owners 0 and 1, in owner order.
    function _both(bytes32 digest) internal view returns (OwnerSig[] memory s) {
        s = new OwnerSig[](2);
        s[0] = OwnerSig({owner: 0, auth: PasskeySigner.sign(ownerP256, digest)});
        s[1] = OwnerSig({owner: 1, auth: PasskeySigner.sign(secondP256, digest)});
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Simulated only (outside any broadcast): the call must revert with exactly `err`.
    function _mustRefuse(address target, bytes memory data, bytes4 err, string memory what) internal {
        (bool ok, bytes memory ret) = target.call(data);
        require(!ok, string.concat(what, ": was NOT refused"));
        require(ret.length >= 4 && bytes4(ret) == err, string.concat(what, ": refused with a different error"));
        console.log(string.concat("refused as expected: ", what));
    }

    /// The live demo account's policy (read from Slice 5's account on 7 Oct), for 30 days.
    function _policy() internal view returns (Policy memory) {
        return Policy({
            agentKey: vm.addr(agentKey),
            checkerKey: vm.addr(checkerKey),
            perPaymentCap: 5_000, // 0.005 USDC
            newAddressCap: 2_000, // 0.002 USDC while the address is new
            newAddressPeriod: 7 days,
            waitingPeriod: WAIT,
            expiry: uint64(block.timestamp + 30 days)
        });
    }

    // ---------- step 1 ----------

    function _deploy() internal returns (AccountFactory factory) {
        vm.startBroadcast(deployerKey);
        factory = new AccountFactory(USDC);
        vm.stopBroadcast();
    }

    function deploy() external {
        _keys();
        AccountFactory factory = _deploy();
        string memory obj = "deployments";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "accountTemplate", factory.accountTemplate());
        vm.serializeAddress(obj, "vaultTemplate", factory.vaultTemplate());
        vm.writeJson(vm.serializeAddress(obj, "factory", address(factory)), DEPLOYMENTS);
        console.log("AccountFactory", address(factory));
        console.log("CountersignAccount template", factory.accountTemplate());
        console.log("OrderVault template", factory.vaultTemplate());
    }

    // ---------- step 2: the hosted demo account, again ----------

    function mainAccount() external {
        _keys();
        _mainAccount(_factory());
    }

    function _mainAccount(AccountFactory factory) internal {
        (bytes32 qx, bytes32 qy) = PasskeySigner.publicKey(ownerP256);
        CountersignAccount account = CountersignAccount(factory.predictAccount(qx, qy, WAIT, MAIN_SALT));

        vm.startBroadcast(deployerKey);
        factory.createAccount(qx, qy, WAIT, MAIN_SALT);
        require(USDC.transfer(address(account), 50_000), "fund"); // 0.05 USDC
        vm.stopBroadcast();

        Policy memory p = _policy();
        uint64 dl = _deadline();
        uint64 expiry = uint64(block.timestamp + 30 days);
        OwnerSig[] memory a1 = _first(account, OwnerAuth.setPolicyHash(p, 0, dl));
        OwnerSig[] memory a2 = _first(account, OwnerAuth.setSupplierHash(SUPPLIER, KALIBRE, true, 0, 1, dl));
        OwnerSig[] memory a3 = _first(
            account, OwnerAuth.approveOrderHash(MAIN_ORDER, SUPPLIER, keccak256("demo order"), 30_000, expiry, 2, dl)
        );

        vm.startBroadcast(deployerKey);
        account.setPolicy(p, 0, dl, a1);
        account.setSupplier(SUPPLIER, KALIBRE, true, 0, 1, dl, a2);
        address vault = account.approveOrder(MAIN_ORDER, SUPPLIER, keccak256("demo order"), 30_000, expiry, 2, dl, a3);
        vm.stopBroadcast();

        require(account.owners().length == 1 && account.manageThreshold() == 1, "one owner");
        console.log("main demo account", address(account));
        console.log("its order vault (0.03 USDC, Kalibre Studio)", vault);
        console.log("left in the account for proposals (base units)", USDC.balanceOf(address(account)));
    }

    // ---------- step 3: two owners, on chain ----------

    function twoOwners() external {
        _keys();
        _twoOwners(_factory());
    }

    function _twoOwners(AccountFactory factory) internal {
        (bytes32 qx, bytes32 qy) = PasskeySigner.publicKey(ownerP256);
        CountersignAccount account = CountersignAccount(factory.predictAccount(qx, qy, WAIT, TWO_SALT));

        vm.startBroadcast(deployerKey);
        factory.createAccount(qx, qy, WAIT, TWO_SALT);
        require(USDC.transfer(address(account), 10_000), "fund"); // 0.01 USDC
        vm.stopBroadcast();

        // One owner sets the policy, then adds a second: from here, managing and paying once need both.
        uint64 dl = _deadline();
        Policy memory p = _policy();
        OwnerKey[] memory keys = new OwnerKey[](2);
        keys[0] = _key(ownerP256);
        keys[1] = _key(secondP256);
        OwnerSig[] memory a1 = _first(account, OwnerAuth.setPolicyHash(p, 0, dl));
        OwnerSig[] memory a2 = _first(account, OwnerAuth.setOwnersHash(keys, 2, 2, 1, dl));
        vm.startBroadcast(deployerKey);
        account.setPolicy(p, 0, dl, a1);
        account.setOwners(keys, 2, 2, 1, dl, a2);
        vm.stopBroadcast();
        require(account.owners().length == 2 && account.manageThreshold() == 2, "two owners");
        console.log("two owners; manage 2, release 2");

        // Adding a supplier with one owner is refused; with both it goes through.
        bytes32 supplierDigest = account.ownerDigest(OwnerAuth.setSupplierHash(SUPPLIER, KALIBRE, true, 0, 2, dl));
        _mustRefuse(
            address(account),
            abi.encodeCall(
                CountersignAccount.setSupplier,
                (SUPPLIER, KALIBRE, true, bytes32(0), 2, dl, PasskeySigner.one(ownerP256, supplierDigest))
            ),
            NotEnoughSigners.selector,
            "a supplier added by one owner of two (NotEnoughSigners)"
        );
        uint64 expiry = uint64(block.timestamp + 30 days);
        OwnerSig[] memory both = _both(supplierDigest);
        OwnerSig[] memory order = _both(
            account.ownerDigest(OwnerAuth.approveOrderHash(TWO_ORDER, SUPPLIER, keccak256("d36"), 5_000, expiry, 3, dl))
        );
        vm.startBroadcast(deployerKey);
        account.setSupplier(SUPPLIER, KALIBRE, true, 0, 2, dl, both);
        address vault = account.approveOrder(TWO_ORDER, SUPPLIER, keccak256("d36"), 5_000, expiry, 3, dl, order);
        vm.stopBroadcast();
        console.log("supplier added and order opened by both owners; vault", vault);

        // Either owner stops it alone; starting again needs both.
        OwnerSig[] memory pauseBySecond = _second(account.ownerDigest(OwnerAuth.pauseHash(4, dl)));
        vm.startBroadcast(deployerKey);
        account.pause(4, dl, pauseBySecond);
        vm.stopBroadcast();
        require(account.paused(), "paused");
        console.log("paused by the second owner alone");
        bytes32 unpauseDigest = account.ownerDigest(OwnerAuth.unpauseHash(5, dl));
        _mustRefuse(
            address(account),
            abi.encodeCall(CountersignAccount.unpause, (5, dl, _second(unpauseDigest))),
            NotEnoughSigners.selector,
            "unpausing with one owner of two (NotEnoughSigners)"
        );
        OwnerSig[] memory unpauseBoth = _both(unpauseDigest);
        vm.startBroadcast(deployerKey);
        account.unpause(5, dl, unpauseBoth);
        vm.stopBroadcast();
        require(!account.paused(), "unpaused");
        console.log("unpaused by both owners");
        console.log("two-owner account", address(account));
    }

    // ---------- step 4, after the waiting period ----------

    function twoOwnersPay() external {
        _keys();
        _twoOwnersPay(_factory());
    }

    function _twoOwnersPay(AccountFactory factory) internal {
        (bytes32 qx, bytes32 qy) = PasskeySigner.publicKey(ownerP256);
        CountersignAccount account = CountersignAccount(factory.predictAccount(qx, qy, WAIT, TWO_SALT));
        OrderVault vault = OrderVault(account.vaultOf(TWO_ORDER));

        // The checker holds a payment; paying it once needs both owners.
        Payment memory held = Payment({
            amount: 1_000, invoiceHash: keccak256("d36 invoice INV-0101"), payTo: KALIBRE, deadline: _deadline()
        });
        Decision memory d = Decision({
            invoiceHash: held.invoiceHash,
            outcome: OUTCOME_HELD,
            reasonHash: keccak256("amount_mismatch"),
            evidenceHash: keccak256("d36 evidence")
        });
        bytes memory decisionSig = _sig(checkerKey, vault.decisionDigest(d));
        bytes32 digest = vault.paymentDigest(held);
        vm.startBroadcast(deployerKey);
        vault.recordDecision(d, decisionSig);
        vm.stopBroadcast();
        _mustRefuse(
            address(vault),
            abi.encodeCall(OrderVault.payWithOwner, (held, PasskeySigner.one(ownerP256, digest))),
            NotEnoughSigners.selector,
            "a held payment paid once by one owner of two (NotEnoughSigners)"
        );
        uint256 before = USDC.balanceOf(KALIBRE);
        OwnerSig[] memory both = _both(digest);
        vm.startBroadcast(deployerKey);
        vault.payWithOwner(held, both);
        vm.stopBroadcast();
        require(USDC.balanceOf(KALIBRE) == before + 1_000, "held payment not paid");
        console.log("held payment paid once by both owners; left in the order:", vault.remaining());
    }

    // ---------- a rehearsal of every step, simulated only ----------

    /// Every step against live testnet state in one simulation, with the factory deployed inside
    /// it and the waiting period skipped. Run without --broadcast: nothing is sent and no file is
    /// written; forge's dry run lists each transaction with its gas.
    function rehearse() external {
        _keys();
        AccountFactory factory = _deploy();
        _mainAccount(factory);
        _twoOwners(factory);
        vm.warp(block.timestamp + WAIT + 1);
        _twoOwnersPay(factory);
    }

    /// The steps before the waiting period, simulated: forge's on-chain replay (which cannot skip
    /// the waiting period) accepts these, and its dry run gives each transaction's gas.
    function rehearseSetup() external {
        _keys();
        AccountFactory factory = _deploy();
        _mainAccount(factory);
        _twoOwners(factory);
    }
}
