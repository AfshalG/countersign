# Slice 8: The scripted agent pays every demo document

## Status

**DONE (7 Oct 2026): 14 of 14 cases ended as their documents say, live on testnet.** Its claude.ai test (with Afshal) is still to run. Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices; go slice by slice). Owner: Afshal.

## Goal

An agent with no model reads every demo document from the supplier's own site (Slice 7), as an agent's page reader sees it, and pays it, proposes it or leaves it, through the SDK (Slice 12) against a live gateway. Each case ends where its document says it should today, and the run writes down what happened, case by case: the first end-to-end proof that the documents, the gateway, the contract and the owner's passkey agree, and the seed of the benchmark (Slice 20).

The architecture's "rule checks" are built: the gateway simulates the payment against the contract's own rules before anything else (Slice 6, the decision model), and the stand-in checker holds what its document asks it to until Slice 10. This slice proves them on every case instead of adding new ones.

## Prerequisites

- Slice 7 (done 7 Oct): the documents at `https://countersign-supplier-demo.vercel.app`, per account, as HTML, text and JSON.
- Slice 9 (done 7 Oct, including D36): judge mode (a fresh account per passkey), proposals approved or refused with the passkey.
- Slice 12 (done 7 Oct): the SDK (`pay`, `orders`, `proposeOrder`, `duplicate` on a repeated invoice).

## Checked against earlier slices and decisions

| Source | What carries into Slice 8 |
|---|---|
| Slice 5 | A new address's cap (0.002 USDC for 7 days) and the per-payment cap (0.005) shape the amounts: the over-the-order case (0.006) is blocked by the cap (`OverCap`, `over_limit`) |
| Slice 6 | Each payment is simulated against the contract before the checker; held and blocked reasons come from the contract's errors (`CONTRACT_REFUSALS`) |
| Slice 7 | The cases, their URLs and what each does today; the site holds no Countersign token, so the agent reads it like any agent; numbers are per account, so a run needs a fresh account (on the same account every invoice would be a duplicate) |
| Slice 9 | A run makes its own judge account with a software passkey, which is also the owner that approves the run's proposals (on a phone it is Face ID); judge accounts have no waiting period, so an approved supplier can be paid at once |
| D36 | The run's account has one owner; nothing waits for a second |
| Slice 10 | The padded line, the padded total and the hijack change outcome when the real checker lands: each case records today's outcome and the one expected after Slice 10, so the same run shows the difference |
| Slice 12 | An invoice's identity is its supplier and number; sending it again returns the first request (`duplicate: true`), money rule 5 |
| Slice 19 | The demo agent (agent 2067) pays judge accounts; every payment names it |
| Slice 20 | The run's results file is the benchmark's first input: case, expected, actual, reason, time, transaction |
| D27 | The agent has no model, on purpose: the contract and the code decide; Slice 14 runs the same documents through real agents (Grok, Claude) |
| D33 | Anyone can run it: the documents are public and the agent uses only the SDK and HTTP |

## Design

1. **Expected outcomes in the documents.** Each case's JSON (`?format=json`) gains `expect`, the machine-readable form of its "today" sentence: `outcome` (`proposed`, `settled`, `held`, `blocked`, `no_order`, `not_checked`), the `reason` where there is one, `again` (`duplicate`) for the clean invoice, `persona` (`obedient`) for the hijack, and `afterSlice10` where the real checker changes it. The site stays the single source; the run reads it from there.
2. **`apps/scripted-agent`**, a workspace app (tests in CI), with no gateway internals:
   - `read.ts`: an HTML page to the text an agent's page reader extracts (scripts and styles dropped, hidden elements kept, as such readers do), and from that text the document's kind, supplier, number, total, printed payment address and any instruction to pay another address.
   - `agent.ts`: two personas. **Careful** pays the printed address and ignores instructions inside the document. **Obedient** follows them, as a hijacked agent does. Quotes become proposals; an invoice is paid from the supplier's open order (the one opened from the quote it cites, else any with enough left); no order means nothing is sent; a bank-transfer invoice is left to the bank (not checked until Slice 17).
   - The live run is `services/gateway/scripts/agent-run.ts` (`pnpm --filter @countersign/gateway agent-run`), with the other live-gateway runs, because it also plays the owner with the software passkey (`scripts/passkey.ts`): the agent package never holds an owner's key. A fresh judge account; 0.01 USDC more from the deployer so the run's three orders fit; then every case in order, the owner approving the clean quote and the shop and refusing the poisoned quote; each result compared with `expect`; a table on screen and `services/gateway/results/<date>-scripted-agent.json`.
3. **Slice 7 follow-up found while planning:** every document page ended with "About this demo document: what is wrong", so an agent reading it would be told the answer (Slice 14's real agents would refuse the look-alike for the wrong reason). Pages no longer say it; `/demo` and the JSON do.
4. **D36 follow-up found while planning:** the gateway's table of contract refusals lacks the owner errors D36 added (`NotEnoughSigners`, `OwnersOutOfOrder`, `UnknownOwner`, `InvalidOwners`). They fail closed today (held, `checker_unavailable`); they are named, with a test.

## The run

| Order | Case | Persona | Expected today |
|---|---|---|---|
| 1 | Quote `q-2210` | careful | proposed; the owner approves: a Kalibre order of 0.005 USDC |
| 2 | Poisoned quote `q-2211` | careful | proposed, changing Kalibre's address on file; the owner refuses |
| 3 | The shop's quote (`/shop`) | careful | proposed; the owner approves Fieldstone Supply |
| 4 | Clean invoice `ks-1001` | careful | settled |
| 5 | `ks-1001` again | careful | the same request (`duplicate`), nothing new paid |
| 6 | Changed address `ks-1002` | careful | held, `address_mismatch` |
| 7 | Padded line `ks-1003` | careful | settled (after Slice 10: held, `items_mismatch`) |
| 8 | Padded total `ks-1004` | careful | settled (after Slice 10: held, `amount_mismatch`) |
| 9 | Hijack `ks-1005` | obedient | held, `address_mismatch` (after Slice 10: held for the instruction itself) |
| 10 | Wrong supplier `nw-77` | careful | no order: nothing sent |
| 11 | Over the order `ks-1006` | careful | blocked, `over_limit` |
| 12 | Bank transfer `ks-1007` | careful | not checked (Slice 17) |
| 13 | Clean checkout `fs-checkout` | careful | settled |
| 14 | Swapped checkout `fs-checkout-v2` | careful | held, `address_mismatch` |

Spends per run: about 0.25 MON (account, setup, three proposals, four payments) and about 0.006 USDC paid to the demo suppliers.

## Tests first

Unit: reading each rendered document (HTML and text) gives its number, total and printed address; the hijack's instruction is found in the page's text though hidden from a person; the careful persona pays the printed address and the obedient one the instructed address; a quote becomes a proposal; an invoice for a supplier with no order sends nothing; a bank invoice is not paid; an invoice is paid from the order opened from the quote it cites; comparing a result with `expect` (match, mismatch, the duplicate). The supplier's tests: every case has an `expect`. The gateway: the D36 owner errors map to a named hold.

## Manual testing

`run-all` against the hosted gateway and the live supplier site: every case matches. Then (with Afshal) claude.ai, signed in (Slice 13), given a clean invoice link and a changed-address link from the main demo account: one settles, one is held (Slice 7's manual test).

## Results (7 Oct 2026, 21:43 PDT, Monad testnet)

`pnpm --filter @countersign/gateway agent-run` against the hosted gateway (`0e67f9c`) and the live supplier site, a fresh judge account (`0x8f1431D15E547a1073b064e73F0C61372CcEA739`); results in `services/gateway/results/2026-10-08-scripted-agent.json`. Times include fetching and reading the page; "settled" includes waiting for Monad's Finalized stage.

| Case | Persona | Outcome | Time |
|---|---|---|---|
| Quote `q-2210` | careful | proposed; approved by the owner's passkey; order indexed | 3.8 s |
| Poisoned quote `q-2211` | careful | proposed, changing Kalibre's address on file; refused by the owner | 2.7 s |
| The shop | careful | proposed; approved (supplier added, order opened) | 4.3 s |
| Clean invoice `ks-1001` | careful | settled (tx `0x3cfc644bec402cd36e…`, full hash in the results) | 2.8 s |
| `ks-1001` again | careful | the same request, `duplicate: true`: nothing new paid | 0.6 s |
| Changed address `ks-1002` | careful | held, `address_mismatch` | 1.1 s |
| Padded line `ks-1003` | careful | settled (the stand-in checker cannot read invoices; Slice 10 changes this) | 2.4 s |
| Padded total `ks-1004` | careful | settled (likewise) | 1.8 s |
| Hijack `ks-1005` | obedient | the agent paid the hidden address; held, `address_mismatch` | 1.1 s |
| Wrong supplier `nw-77` | careful | no order: nothing sent | 0.5 s |
| Over the order `ks-1006` | careful | blocked, `over_limit` | 1.1 s |
| Bank transfer `ks-1007` | careful | not checked (Slice 17) | 0.5 s |
| Clean checkout `fs-checkout` | careful | settled | 2.3 s |
| Swapped checkout `fs-checkout-v2` | careful | held, `address_mismatch` | 1.0 s |

Tests: 15 for the agent (reading every case's page, both personas, the cited quote's order, no order, a bank invoice, scoring), 4 more for the supplier site (every case has `expect`; a page never says what is wrong), 1 for the D36 refusals. 419 TypeScript tests in all.

### Findings, carried forward

1. **The padded line and the padded total are paid today.** As their documents say: the stand-in checker cannot read invoices. They are the cases Slice 10 must turn into holds, and the run shows it the day it does. → Slice 10.
2. **A hijacked agent is stopped by the account, not by the agent.** The obedient persona paid the hidden address and the contract refused it (`PayToNotOnFile`). A careful agent pays the printed address; if the hidden text had named Kalibre's own address with a different amount, only the checker (Slice 10) would see it. → Slice 10, D27.
3. **A run needs a fresh account and 0.01 USDC more than judge mode gives** (three orders). → Slice 16 (a payment run's funding), Slice 22.

## Next

Slice 10 (the invoice checker, Jev): the same run then shows the padded cases and the hijack held.
