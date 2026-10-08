# Slice 16: A payment run of 200 invoices, end to end, and the run board

## Status

**PLANNED (8 Oct 2026); building now.** Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). MON: the relayers were topped up to 1 MON each on 8 Oct (Afshal: "top up before the 200-payment run"). Owner: Afshal (gateway); built by Claude. The board's look is Sophie's (`apps/approver/FEATURES.md`); this slice gives it its data and a plain read-only page meanwhile (S12-7).

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

## Decisions (made 8 Oct)

| # | Decision | Decided |
|---|---|---|
| S16-1 | What the run is | The product end to end (supplier pages, the checker, the gateway, the chain), not pre-signed transactions: Spike 3 already measured the chain |
| S16-2 | Group refusal | One passkey signature over the run, the reason and the sorted ids, checked off chain against the owner keys; a refusal moves no money, so the vault's per-payment check is not needed to keep money safe |
| S16-3 | The run page | On the gateway, read-only, until Sophie's board |
| S16-4 | Check concurrency | A setting, sized from a measured burst of dry-run checks |

## Next

Slice 17 (advice-only checks for bank-transfer invoices).
