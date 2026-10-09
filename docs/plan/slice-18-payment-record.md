# Slice 18: The payment record

## Status

**BUILT (8 Oct 2026); live check waits on recording being switched on (Afshal: it spends testnet MON).** Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). Owner: Afshal; built by Claude.

## Goal

Every payment ends with one file an auditor can check without trusting Countersign: what was asked, what was checked and on what evidence, who decided, and the transaction on Monad, as one chain (architecture: "Audit record", row 18: "payment, check, evidence and decision as one chain"; D21: "the payment record keeps the chain"). Each decision with its evidence hash is on Monad, not just in our database.

## What is recorded today (found while planning)

| Outcome | On Monad today | Off chain today |
|---|---|---|
| Settled | `PaymentExecuted` (invoice, address, amount, who decided); the checker's signature is in the transaction itself | the request, its evidence, its events |
| Held by the checker | **nothing**: `recordDecision` exists in the vault and is never called | the checker's evidence |
| Refused by the owner | **nothing**: the passkey's `Decision` is checked by a simulated call, never sent; its "evidence hash" is the request's id, not a hash of any evidence | the signature |
| Held or blocked by the contract's rules, or the checker unavailable | nothing (no checker or owner signature to record) | the simulation's refusal |

## Checked against earlier slices and decisions

| Source | What carries into Slice 18 |
|---|---|
| Slice 5 | `DecisionRecorded(invoiceHash, outcome, reasonHash, evidenceHash, decidedBy)`, written only with the checker's signature (`recordDecision`) or an owner's passkey (`recordDecisionByOwner`); events only, no storage, no money. No contract change |
| Slice 6 | The relayer pool sends transactions that are not payments (`relayer_txs`, as owner actions do), and the finality tracker marks them final |
| Slice 9, D36 | Any one owner refuses; a refusal is the owner's EIP-712 `Decision` signed with the passkey |
| Slice 10, D27 | The checker signs only what it checked; a hold's evidence is its own |
| Slice 16, D18 | A run's holds refused with one signature over the group: that signature is not a per-payment `Decision`, so those refusals stay off chain, with the group's signature in the record |
| Slice 17 | Advice on bank transfers is kept (`advice_checks`) for this record |
| Slice 19 | The agent's ERC-8004 identity goes in the record |

## Design

1. **The evidence hash.** `keccak256` of the evidence as canonical JSON (keys sorted at every level, no whitespace; numbers and strings as JavaScript's `JSON.stringify` writes them, which RFC 8785 adopts). One function in `@countersign/shared`, used by the checker (signing), the gateway (sending) and the verifier (anyone).
2. **A checker's hold, on chain.** When the checker holds a payment it also signs the vault's `Decision { invoiceHash, outcome: held, reasonHash: keccak256(reason), evidenceHash }` (a different EIP-712 type from `Payment`, so it can never release anything). The gateway sends `recordDecision` through the relayer pool (94,000 gas, about 0.01 testnet MON).
3. **An owner's refusal, on chain.** The passkey now signs the hold's real evidence hash (not the request's id), and the gateway sends `recordDecisionByOwner` with it. The app is unchanged: it signs the challenge the approval view gives.
4. **Decisions waiting to be sent** are kept (`decision_records`: the decision, its signature, its transaction) and sent again after a restart; recording never delays or changes the payment's status.
5. **The record file**: `GET /v1/payments/{id}/record` (token), `countersign-record/1` JSON, downloaded as `countersign-record-<id>.json`: the payment (account, order, supplier, invoice, amount, agent and its ERC-8004 identity), the document as given and its hash, the checks (the rules' result, the checker's evidence and its hash), the decision (who, when, why, the owner's signatures), each event, the timings, and what is on Monad (the settlement's and the decision's transactions, blocks and events), with the steps to verify it. Bank-transfer advice: `GET /v1/advice/{id}`.
6. **For an auditor's spreadsheet**: `GET /v1/accounts/{account}/records.csv` (token), one row per payment and per advice: date, invoice, supplier, amount, outcome, reason, who decided, evidence hash, transaction.
7. **Verifying without trusting us**: SDK `verifyRecord(record, { rpcUrl })` and `npx countersign-verify record.json`: recomputes the evidence and document hashes, reads the transactions from Monad and checks their events match the record (invoice, address, amount; outcome, reason and evidence hash). Each check is reported pass or fail.
8. **The payment page** (`/p/{id}`) says when a decision is on Monad, with its transaction.

## Tests first

Canonical JSON and the evidence hash (key order, nesting, numbers; RFC 8785's examples); the checker signs a hold's `Decision` (recovers to its key; not for a release; the hash is of the evidence it returns); the gateway sends `recordDecision` for a checker hold and `recordDecisionByOwner` for a refusal (the signature over the evidence hash), resends after a restart, and records nothing it cannot (rules, checker unavailable, group refusals); the record for a settled, a held, a refused and a blocked payment; the CSV; another account's token refused; `verifyRecord` against a fake chain (a tampered evidence, amount or hash fails); Foundry already covers `recordDecision`.

## Manual testing

A held invoice (KS-1003) and a refused one through the demo account: each decision's transaction on Monad, the record downloaded and verified with `countersign-verify` against Monad's own RPC. About 0.05 MON (Afshal's call).

## Decisions (made 8 Oct)

| # | Decision | Decided |
|---|---|---|
| S18-1 | What goes on chain | Checker holds and owner refusals, each with its evidence hash (settlements already are). Rule outcomes and a checker that did not answer stay off chain: nobody signed them, and the contract's rules can be re-run at the block |
| S18-2 | Evidence hash | keccak256 of canonical JSON (sorted keys), written in-house: JavaScript's own JSON.stringify already follows RFC 8785's number and string rules, so only key order is added, and no dependency is needed for 20 lines |
| S18-3 | Record format | One JSON file per payment, versioned (`countersign-record/1`); a CSV across an account for spreadsheets |
| S18-4 | Recording costs MON | A setting (`RECORD_DECISIONS`, on by default): a hold costs about 0.01 testnet MON, a refusal about 0.02 |

## Built

1. **The hashes** (`packages/shared/src/record.ts`): `canonicalJson` (RFC 8785, tested on the RFC's own number, string and key-order examples), `evidenceHash`, `reasonHash`.
2. **The checker** signs each hold as the vault's `Decision` over the evidence it returns (after the time is written into it), never on a dry run or a release.
3. **The gateway** keeps a signed hold only if it is exactly this hold (its invoice, outcome, reason and evidence hash; otherwise the hold stands, unrecorded), and sends `recordDecision` after the hold is stored. An owner's refusal (one payment) now signs the hold's evidence hash and is sent as `recordDecisionByOwner` (115,000 gas: Monad's estimate 97,978, `scripts/estimate-decision-gas.ts`, nothing sent). `decision_records` keeps each until its transaction is signed; a restart sends the unsent and links the signed (purpose `decision:<id>`). `RECORD_DECISIONS=false` keeps them unsent until it is on. Relayer transactions now keep their block.
4. **The record** (`GET /v1/payments/{id}/record`), **the CSV** (`GET /v1/accounts/{account}/records.csv`, payments and advice) and **advice by id** (`GET /v1/advice/{id}`), all with the account's own token. The payment page names a hold or refusal on Monad.
5. **SDK**: `record(id)`, `verifyRecord(record, { rpcUrl })` and `npx countersign-verify <file>`: the chain id, both hashes, that the decision names this payment and its evidence, the decision's `DecisionRecorded` (invoice, outcome, reason, evidence, who) and the settlement's `PaymentExecuted` (invoice, address, amount), each from the payment's own vault.

Found while building: a refusal's signed "evidence hash" was the request's id; holds were never recorded. Both fixed above.

Tests: 666 across the repo.

## Next

Slice 20 (the benchmark).
