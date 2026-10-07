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

**Part 4: an account for a new passkey** (`POST /v1/demo/account`): the factory creates it, the gateway funds it with a little testnet USDC and opens a demo order, so a judge can try the whole flow (D35, judge mode).

## Tests first

Unit: the assertion parser (ox's shape, the raw browser shape with DER, high-s normalised, a different challenge refused, malformed input). Integration (real Postgres, the fake chain): a held payment's view with both digests equal to the shared EIP-712 types' digests; paying once with a software passkey (scripts/passkey.ts) releases it; refusing refuses it; another action's assertion is refused before the chain is asked; a passkey that is not the owner's is refused; nothing is offered once decided; the CORS preflight.

Testnet (manual): a held payment on the hosted gateway paid once with the owner's software passkey through the approvals API, then (Slice 11) with a phone's Face ID through the app.

## Next

Slice 11 (Sophie): the approver app on these routes. Then Part 2 here, Slice 19.

