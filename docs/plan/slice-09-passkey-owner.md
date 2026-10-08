# Slice 9: The passkey owner

## Status

**DONE (7 Oct 2026), all five parts.** Built and run on Monad testnet: pay once or refuse a hold; approve or refuse a proposed supplier and order; pause and unpause; an account for a new passkey (judge mode) with demo invoices; several approvers (D36), each action needing as many owners as the account requires. Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). Owners: Afshal (gateway, contracts), Sophie (the screens, Slice 11).

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


**Part 5: several approvers (D36), built 7 Oct.** Afshal, 7 Oct: one person tapping every approval reads consumer, not B2B; the firms our sizing counts have accounts-payable teams where adding a vendor or changing bank details needs two people.
- **Contract.** `CountersignAccount` keeps up to five owner keys (P-256) and two thresholds, `manage` and `release`, both between 1 and the number of owners. Owner actions take `OwnerSig[]` (`{ uint8 owner; WebAuthnAuth auth }`, owners in strictly increasing order, so none counts twice) over the same digest as today (unchanged EIP-712 types and nonces). Manage threshold: `setPolicy`, `setSupplier`, `approveOrder`, `closeOrder`, `withdraw`, `setOwners`, `unpause`. One owner: `pause`. The vault's `payWithOwner` needs the release threshold and its `recordDecisionByOwner` (a refusal) one owner; both ask the account (`ownersApprove(digest, sigs, threshold)`), so the owner keys live in one place and `PaymentContext` no longer carries them. `initialize` still takes one key (thresholds 1 and 1), so the factory's signature and judge mode are unchanged. `setOwners(keys, manage, release, nonce, deadline, sigs)` (new EIP-712 type `SetOwners(bytes32 ownersHash,uint8 manage,uint8 release,uint256 nonce,uint64 deadline)`) checks every key is on the curve, none repeats, and both thresholds fit.
- **Deployment.** New account and vault templates and a new factory on testnet; the main demo account recreated on them with the same agent key (ERC-8004 agent 2066 keeps its wallet), the MCP server pointed at it. Accounts made before stay as they are (history and evidence links).
- **Gateway.** Every owner route (approvals, proposals, the stop button, judge-mode setup) collects assertions until the threshold is met: an assertion is matched to its owner by checking it against each owner key (off chain, as refusals of proposals already are), stored until enough arrive, and the action is sent once they do. Views say what is needed: "1 of 2 signed", which owners signed, and which action needs how many.
- **Judge mode.** A judge adds a second passkey (another device, or a teammate) and sets manage to 2, then sees a supplier wait for the second signature while a pause or a refusal goes through with one.
- **Not in this part:** bulk import from accounting systems, policy-based onboarding (D36's next steps), amount tiers.
- **As built, two changes from this plan (Claude, 7 Oct).** (1) The vault asks the account `requireOwners(digest, sigs, purpose)`, the purpose naming the threshold (manage, release, or any one), rather than passing a number: a vault cannot ask for fewer owners than the account requires. (2) `SetOwners` nests the keys, `SetOwners(OwnerKey[] owners,uint8 manage,uint8 release,uint256 nonce,uint64 deadline)` with `OwnerKey(bytes32 qx,bytes32 qy)`, rather than an `ownersHash`: a phone's typed-data view then shows every key being set, and viem hashes it natively (the shared fixture checks Solidity and TypeScript agree).

**Part 5 checked against earlier slices and decisions:**

| Source | What carries into Part 5 |
|---|---|
| Slice 1 | Each passkey is P-256 with user verification; the contract refuses high-s; each owner's assertion is a WebAuthn assertion over the same challenge |
| Slice 5 | The owner actions, their EIP-712 types, nonces and deadlines stay; the `Payment` struct and the vault's rules stay; `paymentContext` loses the owner key (the vault asks the account instead); gas grows by one P-256 check (precompile) per extra signer |
| Slice 6 | Owner transactions go through the relayers with crash-safe storage (`relayer_txs`) |
| Slice 9 parts 1–4 | Every owner route keeps its challenge; a route now holds assertions until the threshold is met; refusing (a hold or a proposal) and pausing stay one owner |
| Slice 12 | The SDK and MCP tools are untouched (agents never sign owner actions); the hosted demo account changes address: `ACCOUNT` on Vercel and the docs |
| Slice 13 | Sign-in unchanged |
| Slice 19 | Agent 2066's wallet is the agent key, not the account: unchanged; the new demo account's policy names the same key |
| D23 | The stop button must work with one person: pause needs one owner |
| D28, D29 | The waiting period and the new-address cap stay as they are |
| D32 | The contract counts the signatures; the gateway only gathers them |
| README claims 1, 2 | Rewritten when this lands: "the owner's passkey" becomes "the owners' passkeys, as many as the account requires" |

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

## Results, part 5 (7 Oct 2026, Monad testnet)

Contracts: 119 Foundry tests (14 new for owners: thresholds, order of signers, an unknown owner, a stranger's passkey, removed owners, sets that cannot work; fuzz and invariants unchanged and passing with 5,000 runs). `contracts/script/D36Testnet.s.sol`, rehearsed first as a simulation (nothing sent), then broadcast:

| Step | Result |
|---|---|
| New factory and templates | factory `0x7b21a2FF0C13f2d1c8D985232663BA6B08082464`, account template `0x5E1812BD0573d7f79909e519dF71b070CBc75907`, vault template `0x95Fff6CBcd4bD637e0DCfbB7b5cf510f109703b0` (tx `0x9624a32743f86d316256d0120a1b43a70f53837bbb02e92de22470ef6e23a5ec`); Slice 5's kept in `deployments/10143-slice5.json` |
| The main demo account, again | `0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9`: Slice 5's owner passkey (software), agent key `0x0f92…1DC3` (agent 2066) and checker key, the live policy (0.005 USDC a payment, 0.002 to a new address for 7 days, a 2-minute waiting period); Kalibre Studio on file; a 0.03 USDC order (vault `0x6c033066C05Eb524119c8C830F937C4bbd17E426`); 0.02 USDC left for proposals |
| A two-owner account | `0x07c91F05A1F204C4923a253B96A943c71F915ce1`: one owner set the policy, then added a second owner with manage 2 and release 2 (`setOwners`, tx `0x5f05a1501c063861c77f11cc9475478b1cfc34bd9cb5c0230d7fcd6a04611cd8`) |
| Adding a supplier with one owner of two | refused, `NotEnoughSigners` (simulated: nothing sent) |
| Adding it, and opening an order, with both | done (txs `0x46ac7185cc6801c218702cdcfbc08d1162fb0c85ec436715a3188bc13ed338af`, `0x8a06efb865a5ddd6c5c132bbbc902dccd13b53bc53ff5f26d25256f95391f4b2`) |
| Pause by the second owner alone | paused (tx `0xb04fbcbc1ff569dbe70ae74fa09996d37ba16724f7f73a774cc8bdcba5e4df2f`) |
| Unpause with one owner; with both | refused (`NotEnoughSigners`); unpaused (tx `0xa619da356923897bba008ea19fa303759f48683e242d3ac43abc99f2621e166c`) |
| A held payment paid once by one owner; by both | refused (`NotEnoughSigners`); paid (tx `0xb601ae0a054502641c9e43b4cb893da376e7d2daa5cf998465b86b70aff30acc`) |
| Gas limits forge sent, which Monad charged in full | one signature: createAccount 250,965; setPolicy 164,302; setSupplier 116,351; approveOrder 307,145; pause 98,579; setOwners 132,325. Two: setSupplier 138,149; approveOrder 329,126; unpause 104,401; payWithOwner 286,392. These are this script's calls, not the gateway's (finding 11) |
| What the gateway's own calls need on Monad (`gas-calibrate`, eth_estimateGas, a judge-mode account, txs from the deployer) | one owner: setPolicy 169,255; setSupplier 107,733; approveOrder 284,406; payWithOwner 243,681; pause 91,265; unpause 76,369; setOwners (two keys) 122,512; recordDecision 86,592. Two owners: setSupplier 127,928; approveOrder 304,759; unpause 96,656; payWithOwner 265,190. An extra signature adds 20,195 to 21,509. The gateway's limits are these times 1.08 for the estimate and 1.08 for a phone's longer client data (Slice 5's rule) |

Gateway: 400 TypeScript tests (26 new: gathering signatures, pay once with two owners and its gas, a proposal approved by two, unpause by two with one deadline, owner changes over HTTP, a demo order not yet indexed). Live, on the hosted gateway (`108ddbb`) and MCP server:

| Step | Result |
|---|---|
| The hosted agent on the new main account (`a2a-smoke`) | lists the 0.03 USDC order; a look-alike invoice held, nothing paid |
| `approvals-smoke`: a hold paid once with the main account's passkey | 200 released, settled 1.5 s later (tx `0x82ec1db439a785ef3eb9a23f731138c19e540a657264dd97438146396dec418d`); refuse 200; the same approval again 409 |
| `owners-smoke`: a fresh judge account (`0x56828F744A43129acF8e8cDC21BaBF587B20855A`) adds a second passkey, manage 2 and release 2 | added in 1.7 s with one signature (the account had one owner) |
| A held invoice, paid once | first owner: `202`, "1 of 2 signed"; second: paid once by both, settled 1.5 s later |
| A proposed supplier and order | first owner: `202`, still pending; second: approved in 2.7 s (both actions sent, each with two signatures) |
| Pause; unpause | paused by the second owner alone; unpause by the first answered `202` (still paused, the same challenge offered again), then by the second: running |

### Findings, carried forward

1. **Railway did not deploy on push (fixed 7 Oct).** The Railway GitHub app was installed on another GitHub organisation but not on Afshal's personal account, so Railway could build the public repo when asked but could not list its branches or receive pushes. Afshal installed it for `countersign` only; the production environment is now connected to `development` (auto deploy on push) with **Wait for CI** on, so a merge deploys only after GitHub Actions pass. Switching production to `main` later is one setting. Verified: merge `9556a23` deployed itself after CI and was live about 105 s later. → Slice 21's deploy notes.
2. The stand-in checker's `testHold` document is how holds are made on testnet until the real checker (Slice 10).
3. **Pay once was offered where the contract can never pay (fixed 7 Oct).** While writing Sophie's brief, the README's claim 2 ("not even the owner's passkey can send it elsewhere", `test_TheOwnerStillPaysOnlyTheAddressOnFile`) contradicted the approvals view, which offered `pay_once` on a hold for an address not on file. Tapping it was safe (`422 contract_refuses`, nothing moved) but the button could never work. Now such a hold offers only `refuse`, `summary.payOnce` says `address_not_on_file`, and `pay_once` is refused as `422 not_offered` before any chain call. The shelved app design's "Pay the new address anyway" is impossible by design: a new address goes through changing the supplier (part 2), then the waiting period. → Slice 11 (`apps/approver/FEATURES.md`), Slice 14 (holds in the chat offer the same actions).
4. **Part 4 needs the new passkey three times, and MON.** The plan said the gateway would open the demo order; owner actions need the owner's passkey, so a judge signs `setPolicy`, `setSupplier` and `approveOrder`. Each account costs about 0.09 MON to set up; the relayers hold about 0.10, so judge mode, Sophie's end-to-end test and Slice 16's runs all wait on more testnet MON. → Slice 22 (the demo's MON budget), D35.
5. **Part 4 broke Slice 6's crash safety for its own transactions (found in the cross-check, fixed 7 Oct).** Every relayer transaction that is not a payment is now stored in `relayer_txs` with its nonce in the same database transaction; the tracker marks it final, recovery re-sends it unchanged, and setup waits on one already on its way. A restart test shows every relayer still settling payments after a crash between signing and sending. → Slice 6's guarantee now covers every relayer transaction, not only payments.
6. **Judge accounts are keyed by passkey, not by WorkOS user (Slice 13's plan).** → Part 3 or Slice 14.
7. **Several owners sign the same challenge at different times (D36).** A challenge carries the owner nonce and a deadline, so the second owner must be shown the first one's challenge, not a fresh one: proposals already fixed their deadline (a week from the proposal), an unpause that needs several owners keeps the first signer's deadline (a day), and an owner change is listed with the account until it goes out. Assertions are kept by the signer's key, not their index, because `setOwners` can renumber owners; a removed owner's signature stops counting. → Slice 11 (the screens show "1 of 2 signed" and who still has to sign), Slice 14 (the chat says an approval is waiting for a second person).
8. **One-owner accounts behave exactly as before.** Their assertion goes out at once as owner 0 and the contract checks it; nothing is stored. Judge mode starts every account with one owner. → Slices 11, 14, 22.
9. **Accounts made before D36 are history.** The gateway encodes `OwnerSig[]` and reads `owners()`; Slice 5's account `0xE890…d603` and judge accounts made before 7 Oct keep their receipts and links but cannot be acted on through the gateway. The hosted agent moved to `0xC127…03A9`. → Slice 12 (`ACCOUNT` on Vercel), Slice 22.
10. **Storage is what costs on Monad.** Creating an account went from a 197,928 limit to 250,965 (the owners array and the thresholds are new storage); a USDC transfer to a new holder was charged 108,544. Each extra owner signature needs 20,195 to 21,509. → Slice 16's MON budget, Slice 22.
11. **Gas limits must come from the gateway's own calls, measured on Monad (found live, fixed 7 Oct).** The first D36 limits were forge's broadcast limits for the deploy script's calls, without Slice 5's second 8% for phones' longer client data. Judge mode's `setPolicy` needs 169,255 on Monad and was sent with 165,000, so it reverted: judge mode could not set up a new account from about 19:49 to about 20:15 PDT on 7 Oct (found by `owners-smoke`; one test account was left half set up). `scripts/gas-calibrate.ts` now measures every owner action, one owner and two, with Monad's eth_estimateGas on the gateway's own calls, and the limits are set from it. Also found by the live smoke: the send step gave every pay-once the one-signature limit, so a two-owner pay-once would have run out of gas; it now adds gas per signer. → Slice 16 (re-run `gas-calibrate` before the 200-payment run), Slice 22.
12. **A demo invoice asked for right after setup said the order was used up (found by `owners-smoke`, fixed 7 Oct).** The demo agent finds its order through the gateway's index, which follows finalized blocks, so for a few seconds after setup the order is not there. The agent now waits up to 15 s for the account's own demo order, then answers `409 order_not_indexed` (try again); `order_used_up` means indexed with nothing left. Predates D36. → Slice 11 (the judge's "send an invoice" button can show "one moment").

## Next

Slice 11 (Sophie): the approver app on these routes, briefed in `apps/approver/FEATURES.md`. Slice 9 is done. Next: Slice 19 (ERC-8004 agent identity and the A2A door).

After part 5 (7 Oct): Sophie's brief has feature 8 (owners, thresholds, adding an approver, the "1 of 2 signed" waiting state). Slice 19 is done; next in order is Slice 8 (a scripted agent pays every demo document end to end).

---

Map: [CONTEXT-MAP](../../CONTEXT-MAP.md)
