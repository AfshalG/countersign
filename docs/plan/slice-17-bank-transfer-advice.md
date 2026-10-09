# Slice 17: Advice for invoices paid by bank transfer

## Status

**DONE (8 Oct 2026): live on testnet.** Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). Must-ship (D14). Owner: Roshan (checker), Afshal (gateway); built by Claude.

## Goal

Most suppliers are still paid by bank transfer (8 of 148 small US businesses planned to use stablecoins: architecture, "The honest limit"). A bank transfer happens inside the bank, so from outside we cannot stop one. What we can do is give the same check as advice: an agent about to pay a bank invoice asks Countersign, and gets **`match`**, **`mismatch`** or **`unsure`**, with the evidence. The headline case is the oldest fraud in accounts payable, and the one the demo site already has: an invoice saying "we have moved to a new bank: use the account below" (KS-1007).

It creates no payment request and moves no money (architecture, "Advice-only check").

## Checked against earlier slices and decisions

| Source | What carries into Slice 17 |
|---|---|
| D14 | Stablecoins stay the centre (the only rail where the check is enforced); bank-transfer advice is must-ship, and the app and pitch say plainly that it is advice |
| D27, D32 | The model can only add a concern; the checker is a detector, measured |
| Slice 10 | The checker reads the invoice itself (its page or text), compares it with the order's quote in code, then asks Jev fixed questions; the same reading and the same findings here |
| Slice 12 | `check_invoice` was always meant for bank invoices too (architecture, MCP tools) |
| Slice 15 | Like a supplier's website, the supplier's bank account on file is what the owner approved, never what an invoice says |
| Slice 7 | KS-1007 (a changed account number) expects advice; a clean bank invoice is added |

## Design

1. **The supplier's bank account on file**: holder, IBAN (or account number with sort code or routing number) and BIC, per account and supplier (`supplier_banks`). The owner records it with their passkey: `POST /v1/owner/{account}/banks/preview` gives the challenge and the details read back, then `POST /v1/owner/{account}/banks` with any one owner's signature over the chain, the account, the supplier and the details, checked off chain against the owner keys (a bank account is not on chain: the contract pays only USDC). The demo supplier, Kalibre Studio, has its account on file for every demo account, as its website is.
2. **The checker reads bank details** from the invoice (an IBAN with its mod-97 check, a BIC, a UK sort code and account number, a US routing and account number, the account holder) and, for a bank invoice (its own route, `POST /v1/advise`), compares them with the account on file in code: a different account is `bank_account_mismatch` (a new reason); an IBAN that fails its check digits is unsure. The USDC-only checks (the payment's invoice id, address and amount) are skipped; the supplier, the arithmetic, the prices against the quote and hidden instructions are checked as for any invoice, and the model is asked whether the invoice asks to pay any account other than the one on file. It never signs.
3. **`POST /v1/advice`** on the gateway (the service token, or the account's own token): the order the invoice is against and the document. Answers `match`, `mismatch` or `unsure`, with the reason in plain words, the account on file and the one the invoice gives, and the checker's evidence. Each advice is kept (`advice_checks`) for the payment record (Slice 18). No payment request, no money.
4. **SDK `advise()`** and **MCP `check_invoice` with `bankTransfer: true`**: the agent's answer says it is advice, and on a mismatch, not to pay and to confirm the account with the supplier by phone, from a number on file, not from the invoice.
5. **The demo site**: KS-1007 expects advice `mismatch`; a new clean bank invoice, KS-1008, expects `match`.

## Tests first

The reader (IBANs with and without spaces, a bad check digit, BIC, sort code and account number, routing and account number, the holder); the compare (same account: match; another IBAN: mismatch; unreadable: unsure; nothing on file: unsure); the checker over HTTP for `rail: "bank"` (never signs; KS-1007's page: mismatch; KS-1008's: match); the gateway route (advice kept, no payment request created, an account token for another account refused); the owner's bank route (wrong passkey, wrong challenge, stored and used next); the MCP tool's wording.

## Manual testing (no MON: nothing is sent)

KS-1007 and KS-1008 from the demo site through `check_invoice` on the hosted MCP server and through the SDK: mismatch and match, with the evidence.

## Decisions (made 8 Oct)

| # | Decision | Decided |
|---|---|---|
| S17-1 | Where the bank details on file live | The gateway's database, recorded with an owner's passkey (checked off chain): a bank account is not on chain, and the advice cannot be enforced anyway |
| S17-2 | Who reads and compares | The checker, as for USDC invoices (one reader, one set of findings), on its own route `POST /v1/advise` (changed while building, from a `rail` field on `/v1/check`: the signing check's contract stays exactly as other checkers implement it, and advice is optional for a checker); the checker spec says so |
| S17-3 | Verdicts | `match`, `mismatch`, `unsure` (architecture); a new reason, `bank_account_mismatch` |
| S17-4 | The agent's words on a mismatch | Advice only: do not pay; confirm the account with the supplier by phone from a number on file, never one on the invoice |

## Built

1. **Shared check digits** (`packages/shared/src/bank.ts`): IBAN (ISO 13616, mod 97) and US routing (3-7-1), used by the checker reading an invoice and the gateway taking an owner's account.
2. **The checker** (`services/checker/src/bank.ts`, `advise.ts`, `POST /v1/advise`): reads IBANs (labelled, cut at the end of their field, the longest run of groups whose check digits hold; unlabelled ones only if they hold), BICs, sort codes, routing and account numbers and the holder from the text a person sees. A UK IBAN carries its sort code and account number, so either form matches. Code checks that need no payment run as for USDC (`codeChecks` with no payment: the printed USDC address against the address on file; the invoice id and amount skipped). A definite finding in code is the advice, without the model; otherwise the model gets the same questions with a bank question, within 5 s.
3. **The gateway**: `supplier_banks` and `advice_checks` (migration 0010); `POST /v1/advice` (service or account token), `GET /v1/accounts/{account}/banks`, and the owner's preview and put routes. The demo supplier's account is known (`KNOWN_BANKS`, kept equal to the demo site's by a test), as its website is. A checker that does not answer is `unsure` (`checker_unavailable`), never a match; a gateway without an advising checker answers 503.
4. **SDK `advise()`**, **MCP `check_invoice` with `bankTransfer`** (needs `invoiceText`; `payTo` is now needed only for USDC), and the **scripted agent** asks for advice on bank invoices (careful persona) instead of skipping them.
5. **Demo site**: Kalibre's account on file (the standard example IBAN, no real account), KS-1008 (clean bank transfer, expects match), KS-1007 expects mismatch.

Tests: 636 across the repo (the checker's bank reader and advice, the gateway routes with a real passkey and Postgres, the remote call, the SDK, the MCP tool, the agent's decision).

## Live check (8 Oct, through the hosted MCP server)

The demo site's two bank invoices, read as text and passed to `check_invoice` with `bankTransfer` on the demo account, through the hosted MCP server, the gateway and the real checker. No MON: nothing is sent.

| Invoice | Advice | Time | How |
|---|---|---|---|
| KS-1007 ("we have moved to a new bank") | **mismatch**, `bank_account_mismatch` | 1.3 s | in code: the IBAN and the bank's code differ from the account on file; the model was not asked |
| KS-1008 (Kalibre's own account) | **match** | 1.6 s | code found nothing; the model (Jev 1.13) was asked and raised nothing |

Found by the check: the agent's answer said "cannot stop a bank transfer" twice (the gateway's sentence and the tool's); fixed so it says it once.

## Next

Slice 18 (the payment record export).
