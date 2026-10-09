# Slice 16: A payment run of 200 invoices, end to end, and the run board

## Status

**DONE (8 Oct 2026).** Built test-first and run live on Monad testnet (results below). Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). MON: the relayers were topped up to 1 MON each on 8 Oct (Afshal: "top up before the 200-payment run"). Owner: Afshal (gateway); built by Claude. The board's look is Sophie's (`apps/approver/FEATURES.md`); this slice gives it its data and a plain read-only page meanwhile (S12-7).

## Goal

Spike 3 measured the chain alone: 200 payments signed in advance settled in 5.4 s. This slice runs **the product**: 200 real invoices, read from the supplier's own pages, handed to the gateway as one run by an agent through the SDK, each checked by the real checker (which reads the invoice and asks Jev), then settled, held or blocked. Some are doctored. Two agents send overlapping invoices at the same moment. We publish what we measure (architecture, "Numbers to publish"): time from intake to the last decision, how many were held and why, how many doctored invoices were caught, how many clean ones were wrongly held.

And the person's side at volume (D18, D20): a run board that shows the run live with holds grouped by reason, and refusing every hold of one reason with one passkey signature.

## Checked before writing this (8 Oct)

- **What exists:** `POST /v1/runs` (up to 500, one run id), `GET /v1/runs/{id}` (counts by status and every request), the SDK's `payMany`, MCP's `pay_invoices`, the feed (`runId` in each change), and the check worker's concurrency (8, fixed in `main.ts`).
- **The checker:** 1.5 s per check (`BUDGET_MS`), one model request with at most one retry, no cap of its own; the gateway's 8 parallel checks are the cap (D16). Whether Jev's provider takes 200 checks in a burst is **not known**: a refused model call is a hold (`checker_unavailable` or `checker_unsure`), so a rate limit would show up as clean invoices wrongly held. Measured first, with dry-run checks, which cost no gas.
- **Refusing today** takes one passkey signature per payment, over that payment's own Decision (in its vault's EIP-712 domain), checked by the vault (`verifyOwnerDecision`). A refusal moves no money.
- **MON:** about 0.027 MON per payment at its gas limit (266,000 at ~103 gwei), so a run of 200 is about 5.5 MON; the relayers hold 8 MON. USDC: about 0.2 test USDC, from the funding wallet (1.85).

## Checked against earlier slices and decisions

| Source | What carries into Slice 16 |
|---|---|
| Spike 3 (S3-1 to S3-7) | 8 sending wallets, each on one endpoint, nonces in order; the chain alone: 5.4 s for 200; vaults for isolation, not speed (so the run spreads across several orders, and we never credit vaults with speed) |
| D15, D16 | One run id for the batch; checks in parallel under a cap sized to the model's real limit; code checks first, so an obvious mismatch never waits for the model |
| D18 | Holds grouped by reason; "refuse all duplicates" in one step |
| D20 | The run board is one of the app's screens (Sophie's design) |
| D27, D32 | A model failure holds, never releases; the checker is measured as a detector |
| D36 | Refusing needs any one owner |
| Slice 10 | The real checker reads each invoice's page; its catch rate and false holds on the demo set |
| Slice 12 part 2 | The run is made by a test account, as any developer would |
| Slice 15 | Kalibre's website proof is checked for each payment (`website_changed`): one cached lookup, no Primus call per payment |

## Design

1. **Run summary** in `GET /v1/runs/{id}`: the account, when it was submitted, when the last payment was decided and finalized, intake-to-last-decision time, each settled payment's request-to-final time (p50, p95), and holds grouped by reason with their ids. `GET /v1/accounts/{account}/runs` lists an account's recent runs.
2. **The run page** `/r/{runId}` on the gateway: public like `/p/{id}` (the id is an unguessable hash), read-only, refreshing itself: counts, the time so far, holds grouped by reason with a link to each approval page. Plain, like the status pages; Sophie's board replaces it.
3. **Refusing a group with one signature** (D18): `GET /v1/approvals/runs/{runId}?reason=…` lists a run's holds for one reason and the challenge to sign: `keccak256(abi.encode("Countersign: refuse held payments", chainId, account, keccak256(ids)))`. `POST` with one owner's assertion refuses them all, checked off chain against the account's owner keys (as refusing a proposal is). Each refused payment keeps the group signature and the list as its owner evidence. No token: the passkey is the authorisation, like every approvals route.
4. **Check concurrency as a setting** (`CHECK_CONCURRENCY`, default 8): sized from the measured limit, not guessed (D16).
5. **The run** (`pnpm --filter @countersign/gateway run-200`): a test account; several orders with Kalibre Studio on its quote, approved with the owner key; 200 invoices from the supplier site, numbered apart by run labels: mostly clean, with the doctored cases mixed in (a look-alike address, a padded line, a padded total, hidden instructions, an invoice already paid); submitted as one run through the SDK while a second agent sends 20 of the same invoices at the same moment. It records every request's timings and writes `results/<date>-run-200.json`.

## Tests first

The run summary (timings, percentiles, holds by reason, a run still in progress, another account's run unknown to an account token); the runs list; the run page (counts, holds by reason, unknown run 404, no secrets in the page); refusing a group (the challenge covers exactly the listed ids, a wrong passkey or another account's payment refused, a payment decided meanwhile left alone, the group signature kept on each); the setting.

## Manual testing (Monad testnet, about 6 MON)

1. Dry-run checks in a burst (no gas): 40 at once, then 100, through `POST /v1/checks`, to see whether Jev answers or refuses; set `CHECK_CONCURRENCY` from it.
2. The run of 200: intake to last decision, per-payment times, holds by reason, doctored caught, clean wrongly held, duplicates from the second agent (none paid twice), MON spent.
3. Refuse all of one reason with one signature from the owner key; the run page shows it.

## Built (8 Oct)

- **The run board's data:** `summary` on `GET /v1/runs/{id}` (intake to the last decision, each paid invoice's time to final at p50 and p95, holds and stops grouped by reason with their ids), `GET /v1/accounts/{account}/runs`, and the public read-only run page `/r/{runId}` (it reloads until every payment is decided; `?format=json` for a board).
- **Refusing a group with one signature (D18):** `GET`/`POST /v1/approvals/runs/{runId}?reason=`: one owner signs a challenge over the run, the reason and exactly the held ids; checked off chain against the owner keys; a list that changed meanwhile is `challenge_mismatch` and nothing is refused; each refused payment keeps the signature and the list.
- **`run-200`:** a test account, ten orders on Kalibre's quote approved with the owner key, 200 invoices read from the supplier's pages (170 clean, six each of five doctored kinds), one run through the SDK with a second agent sending 20 of the same at once, the result scored against each document's expected outcome, and the largest group of holds refused with one signature. Funded from the deployer, never from a wallet the gateway sends from.

**Fixed on the way, each found by measuring:**

1. **The checker's time limit started before the gateway's own reads.** 20 dry-run checks at once held 19 as `checker_unavailable`: at volume the gateway's paced chain reads queue, and its own wait used the checker's 2 s. The checker now starts the timer itself when it asks the checker service. After: 100 at once, all answered, in 3.3 s.
2. **Two agents sending the same invoices at once:** a request kept only the run that sent it first, so the other run listed 5 of its 20 and never looked done. `run_requests` (migration `0009`, backfilled) records every invoice each run sent; still one request, and one payment, per invoice.
3. **A quote read as a web page went to the checker as plain text,** so it read no lines and compared no prices: a padded line and a padded total were paid in the first rehearsal. A quote stored as HTML now goes as HTML.
4. **Wallets stuck on transient send errors.** In the first run of 200, the lowest pending transaction on two wallets was in no endpoint's mempool and not mined, and everything after it waited (the last settled about 15 minutes later). A lane only moved when an accepted transaction was not included; one whose sends kept failing with a transient error retried forever on the same endpoint, silently. It now moves after the same stall time, errors and moves are logged, and `/health` shows every lane.
5. **Speed (Afshal: "make sure it's fast, speed matters"):** each payment was simulated three times; now once at the check, and again at the send step only when the check is over 30 s old, it is an owner's pay-once, or its order has no room by the gateway's own count (its amount less what this gateway has sent from that vault; sends to one order are taken one at a time). The read budget moved from sends to reads (21 to 35 a second); payment simulations have their own share, so the finality tracker never waits on them; the check and send workers keep every slot busy instead of waiting for whole batches; 64 checks at once (`CHECK_CONCURRENCY`). Public endpoints count every call in a JSON-RPC batch (Monad) or refuse batches (Ankr, monadinfra), so batching would not help.
6. **A flaky test** (the relayer nonce-order test stalled on a loaded CI machine) never stalls now.
7. **The finality tracker under a run** read one finalized block's receipts at a time and wrote a busy block's payments one by one, so payments were marked final seconds after Monad finalized them (run 3). It reads the next four blocks ahead and writes a block's payments together.
8. **Accuracy at speed:** in run 3 one clean invoice was held because the model missed the checker's 1.5 s budget under 64 checks at once. A checker that does not answer in time (or errs) is asked once more before the payment waits for a person; a judgement is never re-asked, and a second failure still holds. Run 4: 0 false holds.
9. **A new proposal waited for its website check only once the check had started** (found setting up run 4: approval was offered in the gap). With website checks on, a proposal is stored as checking.
10. **Sending at volume (run 4: accurate, but 19.7 s):** 53 lane moves, and all eight wallets ended on monadinfra, the endpoint with the smallest budget, answering 429. Sends were never paced (`sendsPerSecond` was unused); a rate limit counted as a stall and moved the lane; a moved lane went to "the next" endpoint; and a JSON-RPC "requests limited" answer was taken as a final refusal, abandoning the transaction (what stuck two lanes in run 1). Now each endpoint's sends are paced to its budget, a rate limit backs off on the same endpoint and never moves a lane, a stalled lane goes to the least crowded endpoint, and the stall time is 6 s (3 s made lanes move for nothing in a burst).
11. **The finality tracker slowed as accounts accumulated** (the run of 100: the chain finalized every payment within 5 s, but the gateway marked all 85 at once about 8 s later, and all eight wallets "stalled" meanwhile). For every finalized block the order index wrote each account's mark one by one (dozens of accounts after today's runs), and settling waited on it. Now a block's payments are settled first, the index advances every caught-up account in one write, setup transactions resolve after indexing, and no wallet is judged stalled while the tracker is behind.
12. **Receipts from an endpoint that had not seen the block yet** (the 20-invoice check of fix 11: the chain finalized every payment 2.6 s after intake, and the gateway marked them about 7 s later). Receipts were read from whichever endpoint was free, and one a block or two behind answered null, so the tracker backed off for seconds. Pinning every receipts read to Monad's own endpoint (the finality stream's source) left it too few reads a second: idle, `/health` showed the tracker swinging up to 8 blocks behind (`finality.behindBlocks`, added for this). Now the first read takes any free endpoint and a miss goes straight to each other one: idle, 0 to 1 blocks behind. A run to confirm it under load waits for MON (Afshal's call).

## Results (8 Oct 2026, Monad testnet)

Each run: a new test account, ten orders, 200 invoices from the supplier's pages (170 clean, 30 doctored: six each of a look-alike address, a padded line, a padded total, hidden instructions and an amount over the limit), one run through the SDK while a second agent sends 20 of the same invoices, the real checker reading every invoice. "Chain" is intake to the last payment's Finalized stage on Monad; "agent" is from the submission's answer to the gateway marking the last one (what an agent waiting on them sees). Raw records: `services/gateway/results/2026-10-08-run-200-*.json`.

| Run | What changed before it | Chain | Agent | Paid | Doctored caught | Clean wrongly held | MON |
|---|---|---|---|---|---|---|---|
| Rehearsal (20) | the timer, run accounting and HTML-quote fixes | 3.6 s | | 15 | 5 of 5 | 0 of 15 | 0.41 |
| 1 | | stalled: two wallets stuck; the last paid about 15 min later | | 158 | 30 of 30 | 12 (the script's spread overran a small order: `over_limit`) | 4.29 |
| 2 | stuck lanes move; one read fewer per payment; reads 35/s; 64 checks at once; workers without batch waits | 16.4 s | 18.8 s | 170 | 30 of 30 | 0 of 170 | 4.61 |
| 3 | payment simulations in their own read queue | **12.5 s** | 23.1 s | 169 | 30 of 30 | 1 of 170 (the model missed the checker's 1.5 s budget: held, fail-closed) | 4.59 |
| 4 | the finality tracker reads ahead; a checker that did not answer in time is asked once more; a new proposal waits for its website check | 19.7 s | about 28 s | 170 | 30 of 30 | **0 of 170** (200 of 200 as expected) | 4.61 |
| 100 invoices | sends paced per endpoint; a rate limit slows down instead of moving a wallet; a stalled wallet goes to the least crowded endpoint | **5.0 s** | about 13 s | 85 | 15 of 15 | **0 of 85** (100 of 100 as expected) | 2.31 |
| 20 invoices (a check of fix 11) | the order index advances every account in one write per block; a block's payments are settled before indexing | **2.6 s** | about 10 s | 15 | 5 of 5 | **0 of 15** (20 of 20 as expected) | 0.41 |

In runs 2 and 3: every doctored invoice was held or stopped for its own reason (address_mismatch 6, items_mismatch 6, amount_mismatch 6, hidden_instructions 6, over_limit 6); the second agent's 20 were the same requests, each paid once; and the six changed-address holds were refused together with one passkey signature. Each paid invoice went from request to final in a median of 3.8 s (run 2) and 5.5 s (run 3). About 0.027 MON per payment.

Run 3 finished on the chain sooner, but the gateway marked payments later: its finality tracker read one finalized block's receipts at a time and wrote a busy block's payments one by one, while Monad finalizes about 2.5 blocks a second. Fix 7 above reads the next four blocks' receipts ahead and writes a block's payments together.

## Decisions (made 8 Oct)

| # | Decision | Decided |
|---|---|---|
| S16-1 | What the run is | The product end to end (supplier pages, the checker, the gateway, the chain), not pre-signed transactions: Spike 3 already measured the chain |
| S16-2 | Group refusal | One passkey signature over the run, the reason and the sorted ids, checked off chain against the owner keys; a refusal moves no money, so the vault's per-payment check is not needed to keep money safe |
| S16-3 | The run page | On the gateway, read-only, until Sophie's board |
| S16-4 | Check concurrency | A setting, sized from a measured burst of dry-run checks |

## Next

Slice 17 (advice-only checks for bank-transfer invoices).
