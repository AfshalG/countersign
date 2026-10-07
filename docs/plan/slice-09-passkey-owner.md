# Slice 9: The passkey owner

## Status

**DONE (7 Oct 2026).** All four parts built and run on Monad testnet: pay once or refuse a hold; approve or refuse a proposed supplier and order; pause and unpause; an account for a new passkey (judge mode) with demo invoices. Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). Owners: Afshal (gateway, contracts), Sophie (the screens, Slice 11).

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

**Part 2: approving a proposal on chain (BUILT and run on testnet 7 Oct).** The view of a pending proposal offers `approve` (two signatures: `setSupplier`, then `approveOrder`, at consecutive nonces) and `refuse`. The gateway sends both transactions through the relayers, waits for Finalized, and marks the proposal approved. The account must hold the order's USDC.

**Part 3: pause and unpause** from the app, the stop button (D23). Built 7 Oct: `GET`/`POST /v1/owner/{account}` (no token, any origin), the one action that changes the state with a ten-minute deadline sent back with the assertion; checked, dry-run, sent crash-safe, final before answering.

**Part 4: an account for a new passkey (judge mode, D35), BUILT and run on testnet 7 Oct.** Corrected 7 Oct: the gateway cannot open the demo order itself; only the account's passkey can (money rule 8), so the new passkey signs three setup actions. This part comes before 2 and 3 because it lets Sophie's phone (and a judge's) run the whole flow with their own Face ID.
1. `POST /v1/demo/accounts` with the new passkey's public key (as `navigator.credentials.create` gives it, or `{ x, y }`): the gateway checks it is a valid P256 key, creates the account through a relayer (`createAccount`, waiting period 0, stated on screen), sends it 0.01 test USDC from the funding wallet, registers it for indexing, and returns three setup actions with their challenges: `setPolicy` (nonce 0: the hosted demo agent's key, the gateway's checker key, caps 0.005 and 0.002 USDC, 30 days), `setSupplier` (nonce 1: Kalibre Studio at its Primus-proven address), `approveOrder` (nonce 2: 0.005 USDC, 30 days).
2. `POST /v1/demo/accounts/{account}/setup` with the three assertions: each checked against its challenge before any chain call, sent in nonce order, final before the next.
3. `POST /v1/demo/accounts/{account}/invoices` with `clean`, `changed_address` or `amount`: the hosted demo agent pays a demo invoice through the normal pipeline; the clean one settles, the others are held with an approval for the judge's own passkey.
Cost (measured in Slice 5's testnet broadcast): `createAccount` 198k gas, the USDC transfer about 100k, `setPolicy` 154k, `setSupplier` 105k, `approveOrder` 296k: about 0.09 MON per account, plus about 0.05 MON for a payment and a pay once. The routes are off unless a funding key and a daily limit are set; a global daily cap and one account per passkey.

**Part 4 checked against earlier slices and decisions (7 Oct, after building):**

| Source | What carries into Part 4 | Status |
|---|---|---|
| Slice 1 | Passkeys are P-256 (ES256, alg -7) with user verification; high-s refused | The assertion parser normalises s and checks the challenge; the app must create the passkey with `alg: -7` and `userVerification: 'required'` (in `FEATURES.md`) |
| Slice 2, 15 | Supplier addresses are proven, not typed in | The demo supplier is added with no proof (`proofHash` 0), as in Slice 5's testnet setup; README claim 3 already says wiring proofs into approval is Slice 15 |
| Spike 3 | Receipts report the gas limit as gas used; under 10 MON an account moves MON once per 3 blocks; out-of-order nonces are lost | Gas limits taken from Slice 5's testnet limits (execution plus 8%) plus 8% for a phone's longer client data, not from Foundry (whose cold-access prices are below Monad's); the funding wallet moves USDC, not MON; owner actions go one at a time, each final before the next |
| Slice 5 | Owner actions carry the owner nonce and a deadline; `approveOrder` funds the vault from the account; agent and checker keys differ; new-address cap and period | Nonces 0, 1, 2 with a 24-hour deadline; 0.01 USDC funded for a 0.005 order; separate demo agent and checker keys; Part 3's demo invoices must stay at or under the 0.002 USDC new-address cap |
| Slice 6 | Crash safety: a signed transaction is stored with its nonce and re-sent after a restart; the pool is balance-aware | **Gap found:** setup transactions reserved a relayer nonce without storing the signed transaction, so a restart between signing and sending would leave a nonce gap that stalls that relayer's later payments. Being fixed (below). The daily limit is 10, so judges cannot drain the relayers (1.92 MON) |
| Slice 9 part 1 | A changed-address hold offers only refuse | Part 3's changed-address invoice shows refuse only |
| Slice 12 | Orders are indexed from events for registered accounts; hosted MCP serves one account (S12-2) | Demo accounts are registered before their order is opened, so the indexer picks it up; a judge's own account is not yet reachable from claude.ai |
| Slice 13 | Planned: a signed-in person's own account comes with judge mode, keyed by their WorkOS user id | **Not done yet:** demo accounts are keyed by passkey only. Carried to Part 3 or Slice 14 |
| D24, D32, D35, rule 8 | Only public data in views; the contract is the boundary; judge mode; setup only by the owner's passkey | Views show only addresses and amounts; every action is dry-run and checked by the account's passkey verification; nothing is set up without the three signatures |
| D28 | 48-hour waiting period for new or changed addresses | Demo accounts use 0, stated in the API and to be stated on screen; real accounts keep the default |


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

## Results, part 4 (7 Oct 2026, Monad testnet)

`pnpm --filter @countersign/gateway judge-smoke` against the hosted gateway, as a new judge's phone does it (a fresh software passkey; Face ID on a phone), with no service token on the judge-mode calls:

| Step | Result |
|---|---|
| `POST /v1/demo/accounts` with the new public key | account `0x32252f5B45D36F26909cc7E06B7E98c663f30339` created, funded with 0.01 USDC and registered, in 2.9 s; three actions to sign, each with a plain summary |
| `POST /v1/demo/accounts/{account}/setup` with the three assertions | ready in 3.4 s: policy, Kalibre Studio, a 0.005 USDC order, each final before the next |
| The order in the gateway's index | 0.17 s later, 5,000 base units left |
| Again after the crash-safety fix (`418e7f4`, deployed by itself 60 s after CI) | account `0x327214283b068414216EAD53489528E83BFD6276` ready in 3.2 s; health OK, no starved relayer; the order indexed after 8.9 s (right after a fresh start, picked up by the 15 s catch-up rather than the block feed: watched in the demo-invoice work) |
| Tests | 315 TypeScript tests, including 16 for judge mode's flows, 5 for its routes, 3 for its settings, 2 for the funding wallet, and a restart test for transactions that are not payments |

Provisioned: a separate funding wallet (`0x99c1…16Bb`, 0.5 MON and 2 USDC, about 200 accounts), a demo agent key (`0xEB6F…5Df3`), relayers topped up to 0.25 MON each (1.92 MON in one Multicall3 transaction), a daily limit of 10.

**Demo invoices (part 4, second half), 7 Oct**, `judge-smoke` against the hosted gateway (`efc2020`, deployed by itself after CI), a fresh passkey:

| Step | Result |
|---|---|
| Account created; set up with three signatures; order indexed | 2.6 s; 6.2 s; 1.3 s |
| Clean invoice (0.001 USDC to the address on file) | settled in 1.65 s (tx `0xbedba932976e1de31cc06ae13600a303e73fd7754e46ee7db4d6c5935a952c07`) |
| Changed address (a look-alike, same first six and last four characters) | held, "not the supplier's address on file", refuse only; refused with the judge's passkey (200) |
| Amount hold (the stand-in checker, until Slice 10) | held, pay once or refuse; paid once with the judge's passkey, settled 1.35 s later through `payWithOwner` (tx `0x591d9ec41ce81bff7450a31ce3ae513756c0dd47d0552aa28ac3d27a93985527`) |
| Tests | 322, including the real demo agent (our SDK in-process) paying through the full gateway on the fake chain |

## Results, part 2 (7 Oct 2026, Monad testnet)

`pnpm --filter @countersign/gateway proposal-smoke` against the hosted gateway (`20a2330`), a fresh judge account (`0x76dB7fE105b80e589EbB1070e54AEAD199AAE951`), no token on the approval calls:

| Step | Result |
|---|---|
| The agent proposes Northwind Prints, 0.002 USDC, from a quote | the view offers `set_supplier`, `approve_order`, `refuse`, each with a plain summary; the account holds 0.005 USDC |
| Approved with two passkey signatures | approved in 2.9 s (supplier added, then the order opened, each final before the next) |
| The new order | indexed 0.24 s later, 2,000 base units |
| The demo agent pays Northwind from it | settled (tx `0x68ce683f9ec022d49b625a76d9c4dc7448ca52ed60d857e71708230f4ddf30f8`) |
| A second proposal (Southwind Ltd) | refused with the passkey, checked off chain against the account's owner key |
| Tests | 340, including 11 for approving and refusing proposals and 4 for their routes |

Design notes: the supplier's on-chain id comes from its name's slug (`supplierSlug`, so "Kalibre Studio" is Slice 5's `kalibre-studio` and a proposal never makes one supplier into two); the order's hash is the quote the agent read; a changed address is shown as a difference and approving it changes the address for every order (and the waiting period applies); only refuse is offered when the account cannot fund the order.

## Results, part 3 (7 Oct 2026, Monad testnet)

`pnpm --filter @countersign/gateway pause-smoke` against the hosted gateway (`623f679`), a fresh judge account (`0xAF0A374a3F7527b2438Efc412ccfd32DC67ea1e6`):

| Step | Result |
|---|---|
| Pause with the passkey | paused in 1.3 s |
| A clean invoice while paused | held: "The owner has paused the account." (the vault refuses with `AccountPaused`) |
| Unpause with the passkey | running again in 1.2 s |
| The held invoice, paid once with the passkey | settled 1.4 s later (tx `0xff6aae043aedaed2caaddc4f50a9ee445610945a969596e0e0b0c15e2aca3600`) |
| Tests | 344 |

### Findings, carried forward

1. **Railway did not deploy on push (fixed 7 Oct).** The Railway GitHub app was installed on another GitHub organisation but not on Afshal's personal account, so Railway could build the public repo when asked but could not list its branches or receive pushes. Afshal installed it for `countersign` only; the production environment is now connected to `development` (auto deploy on push) with **Wait for CI** on, so a merge deploys only after GitHub Actions pass. Switching production to `main` later is one setting. Verified: merge `9556a23` deployed itself after CI and was live about 105 s later. → Slice 21's deploy notes.
2. The stand-in checker's `testHold` document is how holds are made on testnet until the real checker (Slice 10).
3. **Pay once was offered where the contract can never pay (fixed 7 Oct).** While writing Sophie's brief, the README's claim 2 ("not even the owner's passkey can send it elsewhere", `test_TheOwnerStillPaysOnlyTheAddressOnFile`) contradicted the approvals view, which offered `pay_once` on a hold for an address not on file. Tapping it was safe (`422 contract_refuses`, nothing moved) but the button could never work. Now such a hold offers only `refuse`, `summary.payOnce` says `address_not_on_file`, and `pay_once` is refused as `422 not_offered` before any chain call. The shelved app design's "Pay the new address anyway" is impossible by design: a new address goes through changing the supplier (part 2), then the waiting period. → Slice 11 (`apps/approver/FEATURES.md`), Slice 14 (holds in the chat offer the same actions).
4. **Part 4 needs the new passkey three times, and MON.** The plan said the gateway would open the demo order; owner actions need the owner's passkey, so a judge signs `setPolicy`, `setSupplier` and `approveOrder`. Each account costs about 0.09 MON to set up; the relayers hold about 0.10, so judge mode, Sophie's end-to-end test and Slice 16's runs all wait on more testnet MON. → Slice 22 (the demo's MON budget), D35.
5. **Part 4 broke Slice 6's crash safety for its own transactions (found in the cross-check, fixed 7 Oct).** Every relayer transaction that is not a payment is now stored in `relayer_txs` with its nonce in the same database transaction; the tracker marks it final, recovery re-sends it unchanged, and setup waits on one already on its way. A restart test shows every relayer still settling payments after a crash between signing and sending. → Slice 6's guarantee now covers every relayer transaction, not only payments.
6. **Judge accounts are keyed by passkey, not by WorkOS user (Slice 13's plan).** → Part 3 or Slice 14.

## Next

Slice 11 (Sophie): the approver app on these routes, briefed in `apps/approver/FEATURES.md`. Slice 9 is done. Next: Slice 19 (ERC-8004 agent identity and the A2A door).

