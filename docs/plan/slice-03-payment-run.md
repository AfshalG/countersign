# Slice 3 (Spike): 200 payments on Monad testnet, order vaults against one account

## Status

**BUILDING (7 Oct 2026). D13 answered.** 200 payments settled in 5.4 s from vaults and 6.3 s from one account (8 wallets each); the gap is one endpoint's slow forwarding, and finality is the same, so vaults are not faster at this scale. D13 is kept for isolation (S3-7). 4 wallets: 11.4 s. Still to run, as MON arrives: 1 wallet, the 10-supplier scenario and the duplicates (see "MON budget, measured"). Technical decisions made by Claude; the faucet claims are Afshal's. Owner: Afshal (contracts); Claude builds.

## Goal

Measure, with real transactions on Monad testnet, whether giving each approved order its own vault (D13) lets a run of payments settle faster than paying everything from one account, and find what it costs. Also size the pool of sending wallets, see what happens when two agents submit the same invoice at once, and compare the public RPC with a private one.

This is the evidence behind the pitch's "hundreds of payments in parallel" claim. We publish only what we measure. **The research lowered expectations:** on Monad a conflict costs time, not gas, and a conflicting transaction is re-run at most once, cheaply. Monad's own FAQ calls parallel execution "strictly an implementation detail". Vaults may beat one account by less than the plan implies, or not measurably. Either answer is useful.

**What this spike decides**

| If vaults clearly beat one account | If they don't |
|---|---|
| Slice 5 builds one vault per order as planned; the relayer pool is sized from the measurements; the pitch quotes the measured time for 200 | We find what still conflicts (the token contract's storage, the factory, the relayers) and change D13 before Slice 5 is written |

## Prerequisites

- Slices 0 to 2 done. ✅
- **Testnet MON: about 12 MON in all.** At 102 gwei and paying on the gas limit: 200 vaults at roughly 150k gas, about 3.1 MON; three runs of 200 payments at roughly 80k, about 4.9 MON; the duplicate run, 400 sends of which 200 are refused but still pay, about 3.3 MON; plus a float of about 1 MON per relayer. The deployer has 4.25 MON, so about 8–10 MON more is needed from the faucet. If the faucet can't supply that, the duplicate run drops to 50 pairs (saving about 2.5 MON); the main runs stay at 200.
- **Testnet USDC: 1 USDC is enough.** Payments are 0.001 USDC each: 200 vaults funded with 0.001 and the one-account arm with 0.2 come to about 0.4 USDC. From faucet.circle.com (Monad Testnet).
- **RPC:** the three public endpoints, spread. A private endpoint only if the hackathon's QuickNode perk is a paid tier: QuickNode's free tier (15 requests a second) is slower than its public endpoint (50).

## Cross-checked (7 Oct 2026)

All from docs.monad.xyz pages fetched as Markdown, the Monad source on GitHub (`category-labs/monad-bft`, `category-labs/monad`) where the docs were silent, and live read-only calls against the three public testnet RPCs.

| Topic | Fact | Source |
|---|---|---|
| Version | Testnet runs Monad 0.16.3 (MONAD_TEN). The testnet page's "v0.15.2" is stale | `web3_clientVersion`, `networks.json`, `ai/current-facts.md` |
| Parallel execution | Transactions run in parallel, then commit one at a time in block order; a transaction whose reads were changed by an earlier commit is re-executed (at most twice in all, usually cheaply from cache). Result identical to serial. Conflicts are per storage slot; two reads never conflict; transfers between unrelated parties do not conflict even on the same token | `monad-arch/execution/parallel-execution.md`, `faq.md` |
| Conflict cost | Time, not gas (inferred: fees are gas limit × price, results identical to serial) | as above |
| Order in a block | By total gas price, highest first | `gas-pricing.md` |
| Contract creation | **As on Ethereum:** 32,000 base, 2 per init-code word (+6 for CREATE2), 200 per deployed byte. Measured live: about 201.6 gas per byte. The "160,000 + 1,200/byte" figure was an early draft that Monad dropped (v0.11.3 changelog); Context7 still serves it | `opcode-pricing.md`, `changelog/releases.md`, live `eth_estimateGas` |
| Storage | Cold account access 10,100. Storage is warmed by 128-slot page: first access to a page 8,100, then 100. A new slot on a page's first touch costs 27,900; another new slot on the same page 17,100. Ethereum's 20,000 and 2,900 do not apply | `opcode-pricing.md`, MIP-8 |
| Fees | **Charged on the gas limit.** Minimum base fee 100 gwei; testnet sits at the floor; priority fee fixed at 2 gwei; gas price 102 gwei. Block limit 150M gas; per-transaction limit 30M. Fee below 100 gwei is dropped | `gas-pricing.md`, live |
| Gas limit advice | Hard-code the limit for fixed operations, or use the estimate plus 7.5% | `wallet-developers.md`, `best-practices.md` |
| Transaction pool | **No per-sender pending limit**; pool-wide limits only (16,384 senders, 65,536 transactions). Nonce gaps are held, not rejected, and expire after 5 minutes (15 s under pressure). A replacement needs a strictly higher max fee, with no minimum bump | `monad-eth-txpool` source |
| Reserve balance | 10 MON per EOA. A block includes a wallet's transactions only while the gas of its in-flight transactions (last 3 blocks) stays within min(10 MON, its balance 3 blocks ago); over-budget ones are left out, not charged. Wait 3 blocks after funding a wallet. Contracts are not mentioned | `reserve-balance.md` |
| Finality | 300 ms blocks; Voted after 300 ms; **Finalized after 600 ms**. Tags: `latest` = Proposed, `safe` = Voted, `finalized` = Finalized | `block-states.md`, `json-rpc/overview.md` |
| RPC limits | testnet-rpc.monad.xyz 50 req/s (25 for `eth_call`/`eth_estimateGas`); Ankr 300 per 10 s; monadinfra 20 req/s. `eth_getLogs` capped at 100 blocks on all three (tested live). `monadNewHeads` and `monadLogs` websockets work and carry each block's stage | `testnet.md`, live |
| Sending | `eth_sendRawTransaction` waits up to about 1 s for the pool's verdict. Pending transactions are invisible to `eth_getTransactionByHash`; use `txpool_statusByHash`. `eth_sendRawTransactionSync` returns the receipt once Proposed | monad-rpc source, `json-rpc/overview.md` |
| USDC | Circle testnet USDC at `0x534b…43A3`, 6 decimals, EIP-712 name "USDC". faucet.circle.com supports Monad Testnet (amount and frequency unconfirmed; sources say 1 USDC per 2 hours up to 20). CCTP V2 is live on Monad Testnet (domain 15) | Circle address table, Monad x402 guide |

OpenZeppelin 5.7.0 `Clones` and `ERC20` are read from the installed source in the build.

## Checked against earlier slices

| Slice | What it changes here |
|---|---|
| 0 | Node 24, pnpm 12, TypeScript 6.0.3; settings through the fail-closed loader; Soldeer with the CI cache and retries; one CI job per spike; every commit gated on `pnpm check`, `forge test` and `gitleaks git` |
| 1 | The deployer wallet `0xf8a6…C79B` pays (4.25 MON). **Corrected by this research:** Slice 1's gas limit of estimate plus 20% becomes plus 7.5% or a hard-coded limit, as Monad advises. Slice 1 measured 1.0–1.4 s to finalized by polling; Monad finalizes in 600 ms, so the gap is polling, and this spike times stages from the `monadNewHeads` websocket. **Resolved:** the 5 KB probe's 1.48M gas fits Ethereum pricing (about 200 per byte); the Context7 figure was stale. Log searches stay capped at 100 blocks, so results come from receipts and websockets, not log scans. Explorer links use MonadVision |
| 2 | Scripts exit explicitly with a time limit. Deployment through `forge script` works on testnet. Nothing in Primus bears on payments |
| Architecture | D13 (one vault per order, no shared counters), D15 (batch runs), D17 (private RPC), D22 (signatures bound to the vault and chain), D28 and D29 (waiting period, first-payment cap) all shape the test contracts below |

## Design considerations

**1. Two arms with the same payment logic.**
- **Vaults:** a factory creates one minimal clone (EIP-1167, OpenZeppelin `Clones`) per order and funds it in the same transaction. A payment moves tokens from that vault to the supplier and marks the invoice paid in the vault's own storage.
- **One account:** one contract holds all the money and tracks what is left per order in a mapping. A payment moves tokens from the account to the supplier.

The difference that matters: in the token contract, every payment from one account changes **the same balance entry** (the account's), so Monad has to run them one after another. Payments from separate vaults change separate entries.

**2. Realistic work inside each payment.** Each payment checks a checker signature (ECDSA, bound to the vault and chain as in D22) and the invoice-paid flag, so the gas and the reads match Slice 5. Passkey checks are not included; they read nothing shared and only add gas.

**3. The token: real testnet USDC.** 0.001 USDC per payment, so one faucet drip covers every run. Using Circle's own contract means the storage conflicts measured are the real ones. Funding the 200 vaults all comes out of the deployer's USDC balance, so the funding phase conflicts by nature; it is timed separately from the payment runs.

**4. Three scenarios.**
- 200 payments to 200 different suppliers (the best case for vaults).
- 200 payments to 10 suppliers (same-supplier payments in one block still conflict on the supplier's balance; measures how much).
- 200 invoices each submitted twice at once by different senders (several agents). Expected: exactly one of each pair pays, the other is refused. A refused transaction still pays its fee, so the gateway (Slice 6) must catch duplicates before sending.

**5. The relayer pool.** Monad has no per-sender pending limit, and the reserve rule only caps the gas one wallet can have in flight (min(10 MON, its balance)). At about 80k gas per payment, a wallet holding 1 MON can have about 120 payments in flight. So one wallet *could* send all 200; a pool exists so one stuck nonce cannot hold up the rest. The spike runs scenario 1 with 1, 4 and 8 wallets, each funded with about 1 MON and left 3 blocks before use, and measures the difference.

**6. Sending fast without being throttled.** Gas limits are hard-coded per operation once measured (no `eth_estimateGas` per payment, which is limited to 25 a second). Sends are spread across the three public endpoints. Each wallet's nonces are tracked locally; a gapped transaction is re-sent if it has not appeared within a few seconds.

**7. What is measured.** For each transaction: time sent, the block, and the times its block was Proposed, Voted and Finalized (from the `monadNewHeads` websocket), gas limit and gas used, success or revert. For each run: wall time from first send to last finalized, blocks used, transactions per block, total MON spent. Monad does not expose re-execution counts, so conflicts show up only as time and blocks per run; the one-account arm is the control.

**8. Spike code lives in `spikes/03-payments/`** and is never imported by product code.

## What gets built

```
spikes/03-payments/
├── README.md                    results table, how to run
├── foundry.toml, remappings.txt same compiler settings; OpenZeppelin 5.7.0, forge-std through Soldeer
├── src/OrderVault.sol           clone: initialize(account, supplier, checker); pay(invoiceId, amount, checkerSig)
├── src/VaultFactory.sol         openOrder(supplier, amount): clone, initialise and fund in one transaction
├── src/SharedAccount.sol        the one-account arm: per-order remaining, the same checks
├── test/*.t.sol                 unit, fuzz and gas tests
├── script/Deploy.s.sol
├── ts/nonces.ts (+ test)        per-wallet nonce allocation, retries
├── ts/run.ts                    sends a scenario through N wallets, records every transaction
└── ts/report.ts (+ test)        turns the records into the results table
```

## Tests first

**Foundry**
1. A vault pays its supplier with a valid checker signature.
2. The same invoice twice: the second is refused (`AlreadyPaid`).
3. More than the vault holds: refused.
4. A signature for another vault, another chain or another invoice: refused.
5. A clone cannot be initialised twice; the factory initialises in the same transaction as it creates.
6. The one-account arm: the same five behaviours.
7. Fuzz: random amounts and signatures never move more than the order allows.
8. Gas: creating and funding a vault; one vault payment; one account payment.

**Vitest**
1. Nonce allocation: each wallet's nonces are consecutive; a failed send is retried with the same nonce; no two sends share a nonce.
2. The report: timings, per-block counts and totals computed correctly from sample records.

## Git workflow

```bash
git checkout development && git pull
git checkout -b feature/spike-03-payments
# commits gated on pnpm check, forge test and gitleaks git; merged only after CI passes
```

## Manual testing (the actual spike)

1. Deploy the contracts; create and fund 200 vaults. Record gas per creation.
2. Run scenario 1 through the vaults, then through the one account. Record the wall time for each.
3. Run scenario 1 through the vaults with 1, 4 and 8 sending wallets.
4. Run scenario 2 (10 suppliers) through the vaults.
5. Run scenario 3 (duplicates) through the vaults: exactly one of each pair paid, the other refused.
6. Repeat scenario 1 on a private endpoint, if a paid one is available.

## Results (filled in as the runs happen)

Deployed on Monad testnet, 7 Oct 2026: `VaultFactory` `0xD302044D86E017d84eD6201eF87474D3eb30cf5e` (vault template `0xF375…3139`), `SharedAccount` `0x83F4db7781bb067Faeb95F0FD16980F708bEB5d3`, spike checker `0x2e15…0736`. Raw records for every transaction: `spikes/03-payments/results/`.

| Measure | Vaults | One account |
|---|---|---|
| 200 payments, 200 suppliers, 8 wallets: first send to last finalized | **5.4 s** (200 paid, 0 lost, 0 re-sent) | **6.3 s** (200 paid; second attempt, see finding 8) |
| Of which, sending alone | 4.4 s (about 45 a second) | 4.5 s |
| One payment, send to finalized | p50 0.95 s, p95 1.12 s | p50 0.97 s, p95 2.22 s (12 slow inclusions, all through monadinfra) |
| Proposed to finalized (the chain itself) | p50 592 ms | p50 576 ms |
| 200 payments, 10 suppliers | waits on MON | waits on MON |
| Blocks used / most in one block | 16 / 21 | 19 / 21 |
| Execution gas per payment (first payment to a supplier) | 164,449 (limit 176,782) | 171,771 (estimate) |
| Execution gas per payment (supplier already holds USDC) | 147,314 | 153,459 |
| MON per payment (charged on the limit, 102 gwei) | 0.018 | 0.019 |
| Creating and funding an order | 109,300 gas, 0.011 MON per vault | 62,100 gas, 0.0063 MON per order |
| Duplicates: paid / refused | waits on MON | |
| Relayer wallets: 1 / 4 / 8 (200 vault payments) | waits on MON / **11.4 s** (two endpoint moves, none lost) / 5.4 s | |

**Where a payment's 0.95 s goes** (vault run, 200 payments): endpoint accepts it, p50 127 ms; into a proposed block, p50 239 ms (p95 440); voted, +296 ms; finalized, +293 ms. The chain side is Monad's documented 600 ms; the rest is getting the transaction in.

## Findings (7 Oct 2026)

1. **A payment costs about twice the plan's gas.** About 164k for a vault payment and 172k for the one-account payment, not 80k. Monad prices first access to an account at 10,100 and to a storage page at 8,100 (Ethereum: 2,600 and 2,100), and a USDC payment touches the vault, its template, USDC's proxy and USDC's implementation, plus several storage pages. At 102 gwei on the limit, a payment costs about 0.018 MON.
2. **Vaults are not slower or dearer per payment.** A vault payment uses about 4% less gas than the one-account payment (it reads less storage). Creating a vault costs more than adding an order to one account (109k against 62k).
3. **Receipts report `gasUsed` equal to the gas limit.** Execution gas comes only from `eth_estimateGas`; a refused transaction pays its whole limit.
4. **Out-of-order nonces are lost, not held.** Sending each transaction to whichever endpoint was free let a wallet's later nonce reach a node before the earlier one. Those transactions disappeared (`txpool_statusByHash`: "Unknown tx hash") and needed a re-send after 5 s: 10 payments took 9.1 s. Even Monad's own URL sits in front of several nodes. **Ordered sending** (each wallet keeps to one endpoint and sends its next nonce after the previous one is accepted) lost none: 3.0 s for the same 10, 5.4 s for 200.
5. **Under 10 MON, an account may move MON out only once per 3 blocks** (Monad's reserve balance, execution side: the "emptying transaction" exception). A second funding transfer inside that window reverted and still paid its fee. Relayers are funded in one Multicall3 `aggregate3Value` transaction. Paying gas is not affected.
6. **The public endpoints set the run's speed.** JSON-RPC batches give no extra throughput: Monad's endpoint counts each call in a batch, Ankr refuses batches (413) and monadinfra refuses them (403). Monad's endpoint limits `eth_call` to 15 a second (the docs say 25). `txpool_statusByHash` works on Monad's endpoint and monadinfra, not Ankr. `eth_getBlockReceipts` works on all three, so results are read one finalized block at a time.
7. **`monadNewHeads` reports `Proposed`, `Voted`, `Finalized` and `Verified`** for each block, with a `blockId`; stage times are kept per block ID so a replaced proposal cannot lend its times to the finalized block.

8. **An endpoint can accept transactions and never forward them.** In the first one-account run, monadinfra accepted two wallets' transactions without error; none of one wallet's 25 and only 8 of the other's reached a block, and re-sending to the same endpoint (477 times) did not help. 42 of 200 were lost (no MON charged); the run was repeated. **Failover** fixed it: each wallet is a lane, and if its lowest pending nonce is not finalized 3 s after acceptance, the lane moves to the next endpoint, re-sends its pending transactions in order, and sets the old endpoint aside for 30 s. Proved first against a local "black hole" endpoint (10 payments, all landed after one move at 3.3 s), then in the 4-wallet run (two moves, none lost).
9. **Vaults are not faster than one account at 200 payments.** Proposed-to-finalized was the same (592 ms against 576 ms); the one-account run's longer tail (6.3 s against 5.4 s) came from 12 slow inclusions through monadinfra, not from execution. Monad absorbs the conflicts on the account's one USDC balance at about 20 payments a block. Vault payments use about 4% less gas (147k against 153k once a supplier holds USDC); vaults cost more to create (109k against 62k per order).
10. **The pool's size sets a run's speed.** One wallet sends about 6 to 10 payments a second (one at a time, each accepted in about 130 ms): 200 payments took 11.4 s through 4 wallets and 5.4 s through 8. The three public endpoints together cap it at roughly 70 a second at the shares we use.

## Adapted from spec

- **Vaults carry their fixed data as immutable clone arguments** (`cloneDeterministicWithImmutableArgs`: token, supplier, checker), so there is no `initialize` and no uninitialised-clone risk; test 5 ("cannot be initialised twice") does not apply. This is the design Slice 5 already plans. In the spike a vault's remaining budget is its USDC balance; Slice 5 stores the amount left.
- **The factory mixes the opener into each vault's salt**, so nobody can take an address another opener is about to use. Vault addresses are computed locally (pinned by a test against the factory on chain).
- **Funding:** one Multicall3 transaction (finding 5), not one transfer per wallet.
- **Sending:** ordered sending (finding 4) instead of spreading each transaction across endpoints. The endpoints are still all used: wallets are spread across them.
- **Smoke tests of 10 payments** before each kind of run, to catch script bugs for 0.18 MON instead of 3.6.
- **Failover between endpoints** (finding 8), tested with `--simulate-dead-endpoint`, a local endpoint that accepts and drops everything.
- **Relayer funding** covers every transaction at the charged price plus the bid headroom for at most 20 in flight (`walletNeed`, tested), not every transaction at the maximum bid.

## MON budget, measured

Spent: 3.52 MON on setup; 3.61 on the 8-wallet vault run; 2.66 on the first one-account run (the 158 that landed) and 3.37 on its repeat; 3.23 on the 4-wallet run; about 0.8 on smoke tests and funding. Claimed by Afshal: 5 MON, then 5 more. Left: 1.15 MON in the deployer and about 0.8 across the relayers. **Still needed, about 19 MON:** 1 wallet (about 1.5 more than is left); scenario 2's setup (3.5) and its two runs (6.6); the duplicates, 400 sends (6.5), on vaults with money left (vaults 0–9 are used up by the 1-wallet run, so the duplicates use scenario 2's vaults or top those ten up first).

## Commit

The commits above, merged into `development` with `--no-ff` once CI passes.

## Next

Slice 4: one test MCP server reached from Grok, Claude Code, Codex and Muse, and the OpenRouter test agent.

## Decisions (made 7 Oct)

| # | Decision | Decided |
|---|---|---|
| S3-1 | Token for the runs | Real testnet USDC, 0.001 per payment |
| S3-2 | Relayer pool | Measure 1, 4 and 8 wallets, about 1 MON each |
| S3-3 | Scenarios | The three above; the duplicate run drops to 50 pairs if MON is short |
| S3-4 | RPC | Spread across the three public endpoints; a private endpoint only if the perk is a paid tier |
| S3-5 | MON budget | About 12 MON in all; **Afshal claims** 8–10 more MON and 1 USDC from the free testnet faucets |
| S3-6 | Plan corrections carried forward | Gas margin 7.5% (was 20%); D17 reconsidered (free private tiers are slower than public); D13's wording about conflicts made exact |
| S3-7 | D13 after the runs | **Kept: one vault per order, for isolation, not speed.** Each order's money sits in its own contract, so a bug or a misused signature reaches only that order; payments use about 4% less gas. At 200 payments vaults were not faster (finding 9), so the pitch does not claim they are |
| S3-8 | Sending | Ordered per wallet, one endpoint per wallet, failover after 3 s (findings 4 and 8); pool size from finding 10 |

---

