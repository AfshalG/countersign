# Slice 9: The passkey owner

## Status

**BUILDING (7 Oct 2026).** Part 1 (the approvals API: a held payment paid once or refused with the owner's passkey) is being built first, because Sophie's approver app (Slice 11) needs it (D35). Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). Owners: Afshal (gateway, contracts), Sophie (the screens, Slice 11).

## Goal

Everything the owner does, done with the passkey on their phone and enforced by the contract: pay a held payment once, refuse it, approve a proposed supplier and order, pause and unpause, and create an account for a new passkey (the start of judge mode). The gateway prepares exactly what the passkey must sign, checks the assertion, and sends the transaction through its relayers; the owner never needs MON or a wallet.

## Prerequisites

- Slice 1 (done): passkeys from an iPhone, an Android phone and a Mac verified on Monad through `WebAuthn.verify`, user verification required; `ox` 1.8.5 signs in the browser.
- Slice 5 (done): `payWithOwner`, `recordDecisionByOwner`, the owner actions (`setSupplier`, `approveOrder`, `closeOrder`, `pause`, `unpause`, `withdraw`) in the account's EIP-712 domain with a nonce and a deadline; the factory's `createAccount`.
- Slice 6 (done): the relayer pool and finality tracker; `POST /v1/payments/{id}/approve` and `/refuse` (service token, `WebAuthnAuth` fields).
- Slice 12 (done): proposals stored as `pending`; the status page; `REASON_TEXT`; evidence with both addresses.

## Checked against earlier slices and decisions

| Source | What carries into this slice |
|---|---|
| Slice 1 | The challenge is the 32-byte EIP-712 digest; the contract requires user verification and refuses high-s; ox returns `r` and `s` as hex. The gateway accepts what the browser has and normalises s |
| Slice 5 | The digest is always computed by the contract, never taken from the caller, so the gateway's challenge must equal the contract's digest exactly (tested against the shared EIP-712 types). Owner actions carry `ownerNonce()` and a deadline: one action per nonce, so approving a proposal (supplier, then order) is two signatures in order. `approveOrder` funds the vault from the account's USDC: the account must hold the order amount. A new address waits out the waiting period before it can be paid |
| Slice 6 | Approve and refuse already work with the service token; the new routes reuse the same checks (simulate `payWithOwner` first, so a wrong passkey costs nothing). One gateway per relayer set. Relayers hold about 0.10 MON: owner actions need gas too |
| Slice 12 | The status page is the approval link until the app exists; `differences[]` generalises the evidence's two addresses; plain wording from `REASON_TEXT`; proposals are `pending` until the owner signs |
| D24 | The approvals view shows only what is public on chain or already in the agent's message (payees, amounts, statuses), so it needs no token |
| D32 | The contract is the boundary: a passkey assertion is checked by the vault, not trusted by the gateway |
| D35 | Sophie's `ApprovalView`: a summary, `differences[]` and the exact typed data per action; the assertion taken as the browser gives it; built first, so her page uses the real gateway |
| Money rules | Rule 7: a refusal ends the agent's run. Rule 8: setup is never automatic; only the owner's passkey makes a supplier or an order real |

## Design

**Part 1: approvals for held payments (building now).**
- `GET /v1/approvals/{id}`: no token (D24), CORS open (the app runs on another origin). Returns the status, a summary (amount, payee, the address on file, the reason in plain words), `differences[]`, and for a held payment two actions, `pay_once` and `refuse`, each with its `challenge` (the digest the passkey signs) and its typed data (for display and independent checking). A refusal's decision is fixed by the gateway (`reasonHash` = keccak256("refused by the owner"), `evidenceHash` = the request id), so the challenge shown is the one checked.
- `POST /v1/approvals/{id}` `{ action, assertion }`: the assertion as `ox` gives it (hex authenticator data, the client data JSON, `{ r, s }`) or as `navigator.credentials.get` gives it (base64url, a DER signature). The gateway checks it is a `webauthn.get` over that action's challenge (a mismatch is refused before any chain call), derives the indexes, normalises s, then runs the same checks as the token routes: `payWithOwner` simulated, or `recordDecisionByOwner` verified. The passkey is the authorisation.

**Part 2: approving a proposal on chain.** The view of a pending proposal offers `approve` (two signatures: `setSupplier`, then `approveOrder`, at consecutive nonces) and `refuse`. The gateway sends both transactions through the relayers, waits for Finalized, and marks the proposal approved. The account must hold the order's USDC.

**Part 3: pause and unpause** from the app, the stop button (D23).

**Part 4: an account for a new passkey (judge mode, D35), next.** Corrected 7 Oct: the gateway cannot open the demo order itself; only the account's passkey can (money rule 8), so the new passkey signs three setup actions. This part comes before 2 and 3 because it lets Sophie's phone (and a judge's) run the whole flow with their own Face ID.
1. `POST /v1/demo/accounts` with the new passkey's public key (as `navigator.credentials.create` gives it, or `{ x, y }`): the gateway checks it is a valid P256 key, creates the account through a relayer (`createAccount`, waiting period 0, stated on screen), sends it 0.01 test USDC from the funding wallet, registers it for indexing, and returns three setup actions with their challenges: `setPolicy` (nonce 0: the hosted demo agent's key, the gateway's checker key, caps 0.005 and 0.002 USDC, 30 days), `setSupplier` (nonce 1: Kalibre Studio at its Primus-proven address), `approveOrder` (nonce 2: 0.005 USDC, 30 days).
2. `POST /v1/demo/accounts/{account}/setup` with the three assertions: each checked against its challenge before any chain call, sent in nonce order, final before the next.
3. `POST /v1/demo/accounts/{account}/invoices` with `clean`, `changed_address` or `amount`: the hosted demo agent pays a demo invoice through the normal pipeline; the clean one settles, the others are held with an approval for the judge's own passkey.
Cost (measured in Slice 5's testnet broadcast): `createAccount` 198k gas, the USDC transfer about 100k, `setPolicy` 154k, `setSupplier` 105k, `approveOrder` 296k: about 0.09 MON per account, plus about 0.05 MON for a payment and a pay once. The routes are off unless a funding key and a daily limit are set; a global daily cap and one account per passkey.

## Tests first

Unit: the assertion parser (ox's shape, the raw browser shape with DER, high-s normalised, a different challenge refused, malformed input). Integration (real Postgres, the fake chain): a held payment's view with both digests equal to the shared EIP-712 types' digests; paying once with a software passkey (scripts/passkey.ts) releases it; refusing refuses it; another action's assertion is refused before the chain is asked; a passkey that is not the owner's is refused; nothing is offered once decided; the CORS preflight.

Testnet (manual): a held payment on the hosted gateway paid once with the owner's software passkey through the approvals API, then (Slice 11) with a phone's Face ID through the app.

## Results, part 1 (7 Oct 2026, Monad testnet)

`pnpm --filter @countersign/gateway approvals-smoke` against the hosted gateway, the owner's passkey being Slice 5's software key for the demo account:

| Step | Result |
|---|---|
| A held payment's approval, fetched with no token | "Held for the owner", the reason in plain words, actions `pay_once` and `refuse` |
| `pay_once` with the owner's passkey | 200 released; settled 1.36 s later through `payWithOwner` (tx `0xc254f105ab3df93c006d19ef7e5667431cc5dcf184be1f67219813d3642e53a2`) |
| `refuse` with the owner's passkey | 200 refused; nothing paid |
| The same approval sent again | 409 `not_held` |
| Tests | 274 TypeScript tests, including 8 for the approvals routes and 5 for the assertion parser (285 and 10 after finding 3 and Slice 13) |

### Findings, carried forward

1. **Railway did not deploy on push (fixed 7 Oct).** The Railway GitHub app was installed on another GitHub organisation but not on Afshal's personal account, so Railway could build the public repo when asked but could not list its branches or receive pushes. Afshal installed it for `countersign` only; the production environment is now connected to `development` (auto deploy on push) with **Wait for CI** on, so a merge deploys only after GitHub Actions pass. Switching production to `main` later is one setting. Verified: merge `9556a23` deployed itself after CI and was live about 105 s later. → Slice 21's deploy notes.
2. The stand-in checker's `testHold` document is how holds are made on testnet until the real checker (Slice 10).
3. **Pay once was offered where the contract can never pay (fixed 7 Oct).** While writing Sophie's brief, the README's claim 2 ("not even the owner's passkey can send it elsewhere", `test_TheOwnerStillPaysOnlyTheAddressOnFile`) contradicted the approvals view, which offered `pay_once` on a hold for an address not on file. Tapping it was safe (`422 contract_refuses`, nothing moved) but the button could never work. Now such a hold offers only `refuse`, `summary.payOnce` says `address_not_on_file`, and `pay_once` is refused as `422 not_offered` before any chain call. The shelved app design's "Pay the new address anyway" is impossible by design: a new address goes through changing the supplier (part 2), then the waiting period. → Slice 11 (`apps/approver/FEATURES.md`), Slice 14 (holds in the chat offer the same actions).
4. **Part 4 needs the new passkey three times, and MON.** The plan said the gateway would open the demo order; owner actions need the owner's passkey, so a judge signs `setPolicy`, `setSupplier` and `approveOrder`. Each account costs about 0.09 MON to set up; the relayers hold about 0.10, so judge mode, Sophie's end-to-end test and Slice 16's runs all wait on more testnet MON. → Slice 22 (the demo's MON budget), D35.

## Next

Slice 11 (Sophie): the approver app on these routes, briefed in `apps/approver/FEATURES.md` (sample approvals from `pnpm --filter @countersign/gateway sample-approvals`). Then Part 4 here (her own phone's passkey end to end), Part 2, Part 3, Slice 19.

