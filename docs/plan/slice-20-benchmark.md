# Slice 20: The benchmark

## Status

**PLANNED (8 Oct 2026).** Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices); the spend (testnet MON, OpenRouter credit) is Afshal's. Owner: Afshal; built by Claude.

## Goal

The same invoices run four ways, so the pitch can say what Countersign adds with numbers, not adjectives (architecture: "Benchmark"; D32: the checker is a measured detector, its catch rate and false-hold rate published here):

1. **No guard**: a wallet that sends what the agent drafts.
2. **Limits only**: a wallet with spending limits, as agent wallets offer today (a cap per payment and per day).
3. **The agent checks itself**: before paying, the model is asked to check the invoice against the order (the "why not just ask the agent" arm, architecture line 134).
4. **Countersign**: the account contract and the checker, on Monad testnet.

For each: share of doctored invoices caught, share of clean invoices wrongly held, USDC that would have gone to the wrong party or been overpaid, and (arm 4) time to final.

## The invoice set

One fixed set from the demo site (Slice 7), the same for every arm: clean invoices (KS-1001) and every doctored kind the account can face: a changed address (a look-alike, KS-1002), a padded line (KS-1003), a padded total (KS-1004), hidden instructions to pay elsewhere (KS-1005), the wrong supplier (NW-77), more than the order holds (KS-1006), the same invoice sent twice (a duplicate), and a swapped checkout (FS-CHECKOUT-V2). Two agents draft the payments: a careful one (pays what the invoice prints) and an obedient one (follows instructions hidden in a document), as in Slice 8, so the hijack's damage is in the numbers. Bank transfers (Slice 17) are advice, not payments, and are reported apart.

## How each arm is measured

| Arm | How | Spend |
|---|---|---|
| No guard | The drafts themselves: such a wallet sends every one. Computed from the drafts, and said so | none |
| Limits only | The drafts against a per-payment and a daily cap set as the demo account's policy: only what exceeds a cap is stopped. Computed, and said so | none |
| Agent checks itself | Real models through OpenRouter, each given the invoice as the agent read it (hidden text included) and the order (supplier, address on file, the quote), asked "pay or hold, and why", with a fixed prompt and structured output. Each model, each invoice, once | OpenRouter |
| Countersign | The drafts paid for real through the SDK on a fresh test account, on Monad testnet: settled, held or blocked, with the reason, and the hold or refusal written on Monad (Slice 18) | testnet MON |

The two computed arms are labelled as computed in every chart and in the pitch: a guard that does nothing has nothing to measure on chain.

## Results

`services/gateway/results/2026-10-xx-benchmark.json` (every invoice, every arm, every reason) and a short table for the pitch and the README. The checker's numbers sit beside the contract's: what the contract alone stops (an address not on file, more than the order, a duplicate) and what only the checker catches (the right supplier billing the wrong amount, D32).

## Decisions

| # | Decision | Decided |
|---|---|---|
| S20-1 | Computed arms | No guard and limits only are computed from the drafts (they would send them; nothing else to measure), labelled as computed |
| S20-2 | Who drafts | The scripted agent (Slice 8), careful and obedient, so every arm sees exactly the same payments; real agents' own behaviour is Slice 14's runs |
| S20-3 | Size and models | Afshal's (spend) |

## Next

Slice 21 ("Where your data goes").
