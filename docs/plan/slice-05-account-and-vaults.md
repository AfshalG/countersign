# Slice 5: The account and order vaults

## Status

**BUILT (7 Oct 2026); deployed and exercised on Monad testnet.** 105 Foundry tests (unit, fuzz at 5,000 runs in CI, invariants over 256 runs of 128 actions) and the shared EIP-712 types checked in TypeScript; every manual step passed on testnet except the phone's passkey, which moves to Slice 9 (see "Adapted from spec"). Spike 3 kept the vault-per-order shape (S3-7). Owner: Afshal (contracts); Claude built.

## Goal

The core contracts: an **account** owned by a passkey that holds a company's USDC, keeps its suppliers and their addresses, and opens a **vault** for each approved order. A vault pays only that order's supplier, only at the address on file, only within what was set aside, and only with both the agent's and the checker's signatures, or with the owner's passkey for a held payment. Every rule the product promises about money lives here.

## Prerequisites

- Slices 0–4 done (Spike 4 open for apps Afshal doesn't have; nothing here depends on it).
- **Spike 3 measured** (vaults against one account) before the contract code is written. Done 7 Oct: vaults kept for isolation (S3-7).
- Testnet USDC for the testnet deployment.

## Cross-checked (7 Oct 2026)

| Source | What was checked |
|---|---|
| OpenZeppelin 5.7.0 source (installed) | `Clones`: `clone`, `cloneDeterministic`, `cloneWithImmutableArgs`, `predictDeterministicAddress`, `fetchCloneArgs`. `EIP712`: rebuilds the domain when `address(this)` differs from the template's, so each clone has its own domain with the template's name and version. `Initializable`: `initializer`, `_disableInitializers`. `ECDSA.recover` rejects malleable (high-s) signatures. `SafeERC20.safeTransfer`. `WebAuthn.verify(challenge, auth, qx, qy, requireUV)` (Slice 1) |
| Monad (Slice 3 research) | Creation priced as on Ethereum (32,000 + 200 per byte); a new storage slot costs 27,900 on its page's first touch, 17,100 after; cold account access 10,100; fees on the gas limit; conflicts per storage slot cost time, not gas |
| Circle | Testnet USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3`, 6 decimals |

## Checked against earlier slices

| Slice | What it changes here |
|---|---|
| 0 | OpenZeppelin 5.7.0 and forge-std through Soldeer; solc 0.8.37 with `via_ir`; `bytecode_hash = "none"`. **Never pass a caller-supplied digest to `P256.verify`** (zero-hash forgery): owner checks go through `WebAuthn.verify`, which hashes itself. Named errors, each with a test; every external function fuzzed. CI caches dependencies |
| 1 | The owner check is `WebAuthn.verify` with **user verification required** (13.7k gas through the precompile, measured). The challenge is the 32-byte EIP-712 digest. High-s signatures are normalised by the client (ox) and refused by the encoder before sending. Passkeys from iPhone, Android and Mac all verify the same way. Synced passkeys follow the person's Apple or Google account (stated limit) |
| 2 | Not wired here: the supplier-website proof is checked by the probe's rules in Slice 15. The supplier record leaves room for a proof hash. Primus's lessons (pin every field, check age yourself) apply there |
| 3 | **Partly measured (7 Oct):** the spike's vault (immutable-argument clone, the design planned here) costs 109k gas to create and fund and 164k per payment (147k once the supplier holds USDC); the one-account payment costs 172k. Budget gas from these, not the earlier 80k: Monad's 10,100 per first account access and 8,100 per storage page dominate, so keep the accounts and storage pages a payment touches to a minimum. Receipts report the gas limit as `gasUsed`; gas tests here are the source of execution gas. **Answered (S3-7):** one vault per order is not faster than one account at 200 payments; vaults are kept for isolation and about 4% less gas per payment, so this slice's vault design stands, and nothing here may be justified by speed. Payments to the same supplier conflict on its USDC balance whatever the design |
| 4 | No effect on the contracts. Pay tools will be marked destructive in the MCP server |
| Architecture | Contract surface; D13 (vault per order), D21 (evidence: the supplier record keeps when its address became active), D22 (signatures bound to vault and chain), D23 (pause; checker key replaceable while paused; withdraw while paused), D27 (the checker signs only when every code check passes: off chain, Slice 10), D28 (waiting period), D29 (first-payment cap), the stated limits |

## Design considerations

**1. Who signs what.**

| Action | Signed by | Verified as |
|---|---|---|
| Set policy, add or change a supplier, approve or close an order, withdraw, pause, unpause | Owner passkey | `WebAuthn.verify` over the EIP-712 digest of the action, in the **account's** domain; a per-account nonce and a deadline stop replay |
| Pay an invoice | Agent key **and** checker key | Two ECDSA signatures over the same EIP-712 `Payment`, in the **vault's** domain (chain ID + vault address, D22) |
| Pay a held payment once | Owner passkey | `WebAuthn.verify` over the `Payment` digest in the vault's domain |
| Record a decision (held, refused, blocked) | Checker key or owner passkey | Event only; no storage, no money |

Transactions are sent by relayers (Slice 6); signatures, not senders, carry authority. Anyone may send a correctly signed request.

**2. What a payment can never do,** whoever signs: pay an address other than the supplier's address on file; pay before that address's waiting period ends; pay more than is left in the vault, or more than the per-payment cap (lower while the address is new); pay the same invoice twice from one vault; pay while the account is paused, after the order expires or after it is closed.

**3. Vaults are clones with immutable arguments.** `approveOrder` creates the vault with `Clones.cloneDeterministicWithImmutableArgs`, carrying the account, the supplier ID, the order hash and the expiry in the clone's code, not in storage. On Monad every new storage slot costs about 27,900 gas, so only what changes is stored: the amount left, the paid invoices and the closed flag. The account funds the vault in the same transaction. The vault's template calls `_disableInitializers`; clones need no initialiser because their fixed data is immutable.

**4. The account reads, the vault writes its own storage.** A payment reads the policy, the pause flag and the supplier record from the account (reads never conflict), and writes only its own vault's storage and the token balances. No counter shared across vaults (D13). Consequence for D29 below.

**5. D29 without a shared counter.** "Lower cap for the first few payments to a new address" would need a count written by every vault, which reintroduces a shared write. Instead: **while an address is younger than `newAddressPeriod`** (e.g. 7 days after it became active), the lower `newAddressCap` applies. The same protection, decided from a timestamp the account already stores, so it stays parallel-safe. *(An adaptation of D29's mechanism, not its intent; recorded in the architecture.)*

**6. The waiting period can't be shortened in a hurry.** `setPolicy` can lower `waitingPeriod`, but a decrease takes effect only after the current waiting period has passed. Otherwise a tricked owner could set it to zero and add a fraudster's address at once (D28: "cannot be skipped").

**7. Accounts are clones too.** A factory creates each account with `cloneDeterministic`, keyed by the passkey's public key and a salt, and initialises it in the same transaction (OpenZeppelin warns that an uninitialised clone can be initialised by someone else). The address is predictable before creation, so it can be funded first.

**8. Money in and out.** The company sends USDC to its account. `approveOrder` moves an order's amount into its vault. `closeOrder` (owner) and `sweep` (anyone, after expiry) return a vault's remainder to the account, and nowhere else. `withdraw` (owner, also while paused) sends the account's unallocated USDC to an address the owner signs for.

**9. Every revert is a named error,** and every decision emits an event (`PaymentExecuted`, `DecisionRecorded`, `PolicySet`, `SupplierSet`, `OrderApproved`, `OrderClosed`, `Paused`, `Unpaused`, `Withdrawn`) for the feed, the audit record and the benchmark.

**10. If Spike 3 says otherwise.** The payment logic is written once, in an internal library, used by the vault. If vaults give no measurable benefit, the account keeps per-order state in its own storage and calls the same library; the signatures, rules and tests stay the same; only D22's domain changes from vault to account plus order ID.

## How the money moves

```mermaid
flowchart LR
    C[Company wallet] -- USDC --> A[Account<br/>owner: passkey]
    A -- approveOrder: creates and funds --> V1[Vault: order 1<br/>supplier S1]
    A -- approveOrder --> V2[Vault: order 2<br/>supplier S2]
    V1 -- pay: agent + checker sigs,<br/>or owner passkey --> S1[S1's address on file]
    V2 -- pay --> S2[S2's address on file]
    V1 -- close or sweep after expiry --> A
    A -- withdraw: owner passkey --> C
```

## State

**Account (storage):** owner passkey `(qx, qy)`; `policy` {agent key, checker key, per-payment cap, new-address cap, new-address period, waiting period, pending waiting-period decrease and when it applies, policy expiry}; `suppliers[supplierId]` {payTo, activeAfter, active, proofHash (unused until Slice 15)}; `ownerNonce`; `paused`; `vaults[orderId]`.

**Vault (immutable arguments):** account, supplierId, orderHash, expiry. **(storage):** `remaining`, `paid[invoiceHash]`, `closed`.

**`Payment` (EIP-712, vault domain):** `amount`, `invoiceHash`, `payTo`, `deadline`. The order is the vault itself; the invoice hash makes each payment unique within the vault.

## What gets built

```
contracts/
├── src/CountersignAccount.sol        owner actions, policy, suppliers, orders, pause, withdraw
├── src/OrderVault.sol                pay, payWithOwner, close, sweep
├── src/AccountFactory.sol            createAccount, predictAccount
├── src/libraries/PaymentRules.sol    the checks every payment passes (shared if Spike 3 changes the shape)
├── src/libraries/OwnerAuth.sol       EIP-712 digests and WebAuthn verification for owner actions
├── src/interfaces/*.sol
├── test/unit/*.t.sol                 one test per rule and per named error
├── test/fuzz/*.t.sol                 every external function
├── test/invariant/*.t.sol            handler-based invariants (below)
├── test/helpers/PasskeySigner.sol    signs WebAuthn assertions in tests (software P-256 key, as in Spike 1)
└── script/Deploy.s.sol               factory and templates on testnet
packages/shared/src/                  EIP-712 type definitions for Payment and each owner action (TypeScript), with tests that they hash exactly as Solidity does
```

## Tests first

**Unit (one per rule):** owner actions with a valid passkey pass; a wrong key, a used nonce, an expired deadline, a non-UV assertion, a high-s signature each fail with their named error. A payment with both signatures settles; with one, with swapped roles, with a signature for another vault, another chain or another invoice, it fails. Wrong payTo, address inside its waiting period, over the vault's remaining, over the cap, over the new-address cap, duplicate invoice, paused, expired, closed: each its own error. `payWithOwner` pays once and refuses a second time. Close and sweep return money only to the account. Withdraw works while paused. A waiting-period decrease waits.

**Fuzz:** every external function with random inputs never moves money except along the allowed paths.

**Invariants (Foundry handler):**
1. USDC leaves a vault only to its supplier's address on file or back to its account.
2. A vault never pays out more than it was funded with.
3. While paused, no vault pays.
4. No invoice hash is paid twice by one vault.
5. Account balance + all vault balances + everything paid out = everything deposited.

**TypeScript:** the EIP-712 types in `packages/shared` produce the same digests as the contracts (checked against values computed in Foundry).

## Git workflow

`feature/slice-05-contracts` off `development`; commits gated on `pnpm check`, `forge test` (with the `ci` profile) and `gitleaks git --staged`; merged only after CI passes.

## Manual testing

1. Deploy the factory and templates to testnet; create an account for a test passkey; fund it with 0.01 USDC.
2. Add Kalibre Studio's address; confirm a payment inside the waiting period is refused (`AddressNotYetActive`), using a short waiting period set for the test.
3. Approve an order of 0.005 USDC; pay 0.001 with agent and checker signatures; check the supplier received it and the vault's remaining fell.
4. Try the same invoice again: `AlreadyPaid`. Try a look-alike address: `PayToNotOnFile`.
5. Pause; a payment fails; withdraw still works; unpause.
6. Pay a held payment once with the passkey from the Slice 1 phone page.
7. Record gas for each operation, for Slice 6's hard-coded limits.

## Results (7 Oct 2026)

**Deployed on Monad testnet (chain 10143):** `AccountFactory` `0x094250cCC1dDBd8530e4FC9A1C900db3D0D9EB5f`, `CountersignAccount` template `0x282cf7AD04f666C1b704B91f1911C8A21c705f02`, `OrderVault` template `0x9950941673E7479c5b20c8603cC24981c386A59D`. Test account `0xE890B35be32F04032B502Dc4Dc2db8062aD6d603` (software passkey), its order vault `0xbd19BbE40044a3175A3213D8408a434b882CADF4`, paying the demo supplier "Kalibre Studio" at `0x90f9…5fEc`. Script: `contracts/script/Slice05Testnet.s.sol`; every transaction is in `contracts/broadcast/`.

**Manual steps on testnet**

| Step | Result |
|---|---|
| 1. Deploy; create an account for a test passkey; fund it with 0.01 USDC | Passed |
| 2. Add Kalibre Studio; a payment inside the waiting period is refused | Refused: `AddressNotYetActive` (2-minute wait for the test) |
| 3. Approve an order of 0.005 USDC; pay 0.001 with agent and checker | Paid; 0.004 left in the order |
| 4. The same invoice again; a look-alike address | Refused: `AlreadyPaid`; `PayToNotOnFile` |
| 5. Pause; a payment; withdraw; unpause | Payment refused (`AccountPaused`); withdraw worked while paused |
| 6. A held payment paid once with the passkey | Paid with the software passkey (`payWithOwner`), the checker's hold recorded first (`DecisionRecorded`); again: `AlreadyPaid`; another passkey: `InvalidOwnerSignature`. **The phone's passkey moves to Slice 9** |
| 7. Gas per operation | Below |

Refusals were checked by simulation against live testnet state, so they cost nothing.

**Gas on Monad** (receipts report the gas limit as `gasUsed`; execution is the limit less the 8% margin)

| Operation | Gas limit charged | Execution (about) | MON at 102 gwei |
|---|---|---|---|
| Deploy factory and both templates | 5,600,378 | 5,185,535 | 0.571 |
| `createAccount` | 197,928 | 183,267 | 0.020 |
| `setPolicy` (passkey) | 153,729 | 142,342 | 0.016 |
| `setSupplier` (passkey) | 104,685 | 96,931 | 0.011 |
| `approveOrder` (create and fund a vault) | 296,416 | 274,459 | 0.030 |
| `pay` (agent and checker; first payment to the supplier) | 265,911 | 246,214 | 0.027 |
| `payWithOwner` (passkey; supplier paid before) | 231,197 | 214,071 | 0.024 |
| `recordDecision` (checker) | 93,967 | 87,006 | 0.010 |
| `pause` / `unpause` | 88,185 / 71,664 | 81,653 / 66,356 | 0.009 / 0.007 |
| `withdraw` (passkey) | 152,199 | 140,925 | 0.016 |

A product payment costs about 50% more gas than Spike 3's bare vault payment (246k against 164k), because it also reads the account's policy, supplier record and pause flag (another contract and its template, several storage pages: Monad's cold-access pricing). The local EVM figures (`test/Gas.t.sol`: pay 150k) are a regression baseline only.

| Tests | Value |
|---|---|
| Foundry tests | 105: unit (one per rule and named error), 16 fuzz (5,000 runs each in CI), 5 invariants (256 runs × 128 actions in CI), EIP-712 fixture, gas |
| Invariant non-vacuity | A fixed 400-step session makes 70 orders, 18 agent-and-checker payments, 7 owner payments, 19 closes and 5 sweeps with every invariant holding |
| TypeScript | 10 EIP-712 digests in `packages/shared` match the contracts exactly |
| `forge lint` | Clean (block-timestamp and reentrancy-events excluded in `foundry.toml`, reasons written there) |

## Adapted from spec

- **The vault's amount is immutable too.** Clone arguments are account, supplier, order hash, expiry **and amount**; storage keeps `spent` (remaining = amount − spent), `paid` and `closed`. Opening an order writes no vault storage and the vault has no initialiser or privileged setup call at all (the plan had `remaining` in storage).
- **An account's address commits to its passkey and its starting waiting period** (`createAccount(qx, qy, waitingPeriod, salt)`), so whoever creates it first can only create exactly the account the owner expects. Accounts start with no agent or checker key: nothing pays until the owner sets a policy. `createAccount` returns the existing account if called again.
- **The waiting period has a maximum, 30 days** (found while reviewing the linter's warnings). A decrease waits out the current period, so an unbounded period set by a tricked owner could have locked supplier changes for good.
- **Policy checks:** agent and checker keys must both be set and must differ (one key signing both halves would turn two signatures into one); the new-address cap may not exceed the cap; the policy may not already have expired.
- **The owner's path obeys the same rules**, including the pause: the stop button stops the owner's payments too. A payment's agent path also refuses an unset or expired policy (`PolicyNotSet`, `PolicyExpired`).
- **Decisions:** `recordDecision` (checker's ECDSA) and `recordDecisionByOwner` (passkey) are separate functions; `Decision` is (invoice hash, outcome 1–3, reason hash, evidence hash).
- **Events are emitted before their USDC transfers** (checks, effects, then the transfer).
- **Step 6 with the phone moves to Slice 9.** Paying with the phone's passkey needs the phone's key as an account owner and a page that signs each owner action, which is Slice 9's flow (passkey owner: suppliers, orders, pay once). Slice 5 proved `payWithOwner` on testnet with a software passkey through the same `WebAuthn.verify`; Slice 1 proved iPhone, Android and Mac assertions pass that check on Monad.
- **Tests read the clock with `vm.getBlockTimestamp()`**: under `via_ir`, `block.timestamp` can be reused across `vm.warp` (Foundry lint).

## Commit

Commits gated as above, merged into `development` after CI passes.

## Next

Slice 6: the gateway (requests, run queue, relayer pool, finality stream), using the gas figures measured here and in Spike 3.

## Decisions (made 7 Oct)

| # | Decision | Decided |
|---|---|---|
| S5-1 | Owner authority | Passkey via `WebAuthn.verify` (UV required) over EIP-712 digests, per-account nonce and deadline |
| S5-2 | Payment authority | Agent and checker ECDSA signatures over the vault-domain `Payment`; or the owner's passkey for a held payment |
| S5-3 | Vault shape | Clone with immutable arguments; only remaining, paid invoices and closed in storage. Revisited if Spike 3 says so |
| S5-4 | D29 mechanism | Lower cap while an address is younger than `newAddressPeriod` (parallel-safe), instead of a payment count |
| S5-5 | Lowering the waiting period | Takes effect only after the current waiting period |
| S5-6 | Accounts | Deterministic clones from a factory, initialised in the same transaction |

---

