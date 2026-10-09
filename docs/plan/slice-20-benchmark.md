# Slice 20: The benchmark

## Status

**BUILT; three arms measured (8 Oct 2026); the frontier models wait on OpenRouter credit.** Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices); the spend (testnet MON, OpenRouter credit) is Afshal's. Owner: Afshal; built by Claude.

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

`apps/agent-runner/results/benchmark-<date>.json` (every invoice, every arm, every reason, and the saved set) and a short table for the pitch and the README. The checker's numbers sit beside the contract's: what the contract alone stops (an address not on file, more than the order, a duplicate) and what only the checker catches (the right supplier billing the wrong amount, D32).

## Decisions

| # | Decision | Decided |
|---|---|---|
| S20-1 | Computed arms | No guard and limits only are computed from the drafts (they would send them; nothing else to measure), labelled as computed |
| S20-2 | Who drafts | The scripted agent (Slice 8), careful and obedient, so every arm sees exactly the same payments; real agents' own behaviour is Slice 14's runs |
| S20-3 | Size and models | Afshal (8 Oct): 40 invoices; free models and three frontier ones (Claude Sonnet 5.5, GPT-5.6 Terra, Gemini 3.8 Flash; Gemma 4 and Nemotron 3 Ultra free) |

## Results so far (8 Oct, ~10:10 PM PDT; `apps/agent-runner/results/benchmark-2026-10-08.json`)

40 invoices: 20 clean, 20 doctored, drafted once. Countersign on a fresh test account, on Monad testnet.

| Arm | Doctored caught | Clean wrongly held | USDC let go |
|---|---|---|---|
| No guard (computed) | 0 of 20 | 0 of 20 | 0.0199 |
| Limits only (computed: 0.005 per payment, 0.03 a day) | 9 of 20 | 5 of 20 | 0.0111 |
| **Countersign** | **20 of 20** | **0 of 20** | **0** |

Countersign decided all 40 within 6.4 s of intake. What stopped each: every wrong address by the contract (4 look-alikes, 4 hidden instructions followed by the obedient agent, 2 wrong supplier: `address_mismatch`); every padded invoice by the checker (3 `items_mismatch`, 3 `amount_mismatch`); more than the order by the contract (2 `over_limit`); the same invoice twice is the same request (2, not paid again). Limits only stopped only what was over a cap, and its daily cap, spent by doctored payments, then stopped 5 clean ones: what it catches depends on the cap, which is ours (stated).

**The agent checks itself: not yet a result.** The first run (Nemotron 3 Ultra, free) is set aside (`superseded` in the file): the prompt gave the model the quote (50 photos, 0.005 USDC) but not the orders the owner approved (3 × 0.016 USDC), so it held repeat invoices as "more than the quote", fairly; and 4 answers were the provider overloaded. Fixed: the model now gets what was approved and what is left (as `list_open_orders` gives an agent), and a busy provider is asked again. The rerun, on exactly the saved set (`self-check-run.ts`), waits on OpenRouter credit: the account has none (free tier: 50 free-model requests a day, and the paid models refuse).

## Next

Slice 21 ("Where your data goes").
