# Slice 15: The supplier's own website, proven, on every approval

## Status

**PLANNED (8 Oct 2026); building now.** Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices); D10 (Primus in the core) and S2-1 to S2-5 stand. Owner: Afshal (contracts, gateway); built by Claude.

## Goal

When an agent proposes a supplier, or an invoice brings a changed address, the owner's phone says whether **the supplier's own website lists that address**, with a Primus proof checked on Monad, and the supplier record the owner signs names that proof. The pitch's line: "your phone shows the proposal, and whether the supplier's own website lists that address", and on a changed-address hold, "the supplier's website still lists the old one".

Spike 2 proved the pieces: the supplier publishes `{ "payTo": "0x…" }` at `/.well-known/countersign.json`, Primus attests it from our server in about 5 s, and a contract on Monad checks the proof with every field pinned. This slice wires it in, with the fallback when it can't be checked.

## Checked before writing this (8 Oct)

- **Primus Core SDK** (Context7 `/websites/primuslabs_xyz`; npm `@primuslabs/zktls-core-sdk` latest is still 0.3.7, the version Spike 2 used): `new PrimusCoreTLS()`, `init(appId, appSecret, 'wasm')` once at start, `generateRequestParams(request, responseResolves, recipient)`, `setAttMode({ algorithmType: 'proxytls' })`, `startAttestation`, `verifyAttestation`. The server-side SDK, with the app secret; the keys are in the repo's `.env` (S2-5).
- **Spike 2's findings** (all carried): Primus's verifier checks only the signature, so every field is pinned and the time is checked by us; `data` is Primus's JSON of the value (`{"payTo":"…"}`); timestamps in milliseconds; the `attestors` list inside a proof is not signed; signatures are malleable, so never an identifier.
- **The account contract already has the field:** `setSupplier(…, proofHash, …)` stores it and emits it in `SupplierSet` ("the website proof it was approved on (Slice 15); zero until then"). No account redeploy.
- **The demo supplier's site serves the file** (`apps/supplier/app/.well-known/countersign.json`), and its quotes are the two cases: Q-2210 lists Kalibre's address, Q-2211 (poisoned) does not. The quotes do not print the supplier's website yet.
- **OpenZeppelin 5.7.0** (in `contracts/`) has `Strings.tryParseAddress`, so the contract can read the listed address from the proof itself.

## Checked against earlier slices and decisions

| Source | What carries into Slice 15 |
|---|---|
| Slice 2, S2-1 to S2-4 | The file's place and shape; Primus's verifier behind our proxy (`0x643C…18FE`, trusts only `0xDB73…8eF6`); "listed on the supplier's website", never "safe"; 24 hours before a proof is shown as stale |
| D21 (evidence that expires) | Each supplier keeps the proof it was approved on, with its time; stale evidence is shown as stale, never as verified; when the file changes, the next payment re-checks |
| D27, D32 | The proof adds information for the owner and can add a hold; it never releases anything. The contract stays the boundary |
| D35 | Website-proof states: `verified`, `not_listed`, `stale`, `unavailable` (plus `checking` while the proof is made) |
| D36 | Several approvers sign the same challenge, so the proof a proposal binds must not change once anyone can sign |
| Slice 9 | The proposal's approval page and its two steps (`set_supplier`, `approve_order`); approval needs the passkey |
| Slice 10 | The checker's evidence is per payment; the website proof is per supplier, so it lives in the gateway, not the checker |
| Slice 12 part 2 | Test and judge accounts start with Kalibre Studio on file: their setup can carry Kalibre's proof |
| Slice 14 | WhatsApp and the chat carry the link; the page shows the result |
| Slice 7 | The supplier site: the quotes print the website, and a second demo supplier on its own domain shows a new supplier being proven |

## Design

1. **`SupplierProofs` on Monad** (`contracts/src/SupplierProofs.sol`). The product version of Spike 2's probe: `record(attestation, url)` checks the proof (every field pinned as in the probe, the time no more than an hour old, Primus's verifier for the signature), reads the address the file lists out of the proof's data (any letter case), and stores the record `proofHash = keccak256(abi.encode(keccak256(url), listed, signedAt))` with `listed` and `signedAt`, emitting `SupplierProofRecorded`. It records what the website lists, whether or not that is the address an agent proposed: a "not listed" result is proven too. Anyone may record a genuine proof; no owner, no upgrade.
2. **Proofs in the gateway** (`src/proofs/`). With `PRIMUS_APP_ID` and `PRIMUS_APP_SECRET` set (both or none) and the registry's address known, the gateway proves a website: Primus attests `https://<site>/.well-known/countersign.json` (proxy-TLS, WebAssembly build, a 30 s limit), a relayer records it on Monad, and the row `website_proofs` keeps the URL, what it lists, the time, the proof hash and the transaction. A proof of the same URL is reused for 10 minutes (Primus's quota is unknown). Without the keys, every check is `unavailable` and the sheet says "not verified by the supplier's website": the fallback.
3. **Which website.** A new supplier: the website the proposal gives (from the quote), shown by its domain, because a hijacked agent can propose its own site. A changed address for a supplier already on file: **the website on file for that supplier** (from the proposal that first approved it, or Kalibre's for demo accounts), never the new proposal's.
4. **Proposals.** A new proposal starts its check at once. Its approval page gets `summary.website` (`url`, `status`, `listed`, `checkedAt`, `proofHash`, `txHash`) and, while it is `checking`, offers only refuse (at most 60 s; then `unavailable`). When the website lists the proposed address, `set_supplier` signs that proof's hash, so the supplier record on chain names its evidence; otherwise it signs zero. The proof a proposal binds is fixed once the check ends, so every owner signs the same challenge (D36). Older than 24 hours, it is shown as `stale`.
5. **Holds.** A changed-address hold (`address_mismatch`) checks the website on file for that supplier, and its approval page says which address the site lists: the one on file, the invoice's, or another.
6. **Evidence that expires (D21).** Approved suppliers with a website are checked again each day. If the site no longer lists the address on file, the next payment to that supplier is held (`website_changed`, a new reason) until the owner looks; when it lists it again, payments go on.
7. **Judge and test accounts.** Their Kalibre Studio is set up with Kalibre's latest proof (recorded at most once a day), so every new account's supplier record names its evidence on chain.
8. **The demo site.** The quotes print the supplier's website. A second supplier, Northwind Prints, gets its own domain (the same app, chosen by host name) with its own file and a quote, so approving a supplier new to every account shows the proof bound on chain.

## API

| Route | Change |
|---|---|
| `GET /v1/approvals/{id}` (proposal) | `summary.website`; approve actions wait while `checking`; `set_supplier`'s typed data carries `proofHash` |
| `GET /v1/approvals/{id}` (held, `address_mismatch`) | `summary.website` for the supplier's site on file |
| `GET /v1/proposals/{id}` | `website` status alongside the proposal |
| `GET /health` | `proofs: { primus, registry }` |

## Tests first

Foundry: the registry accepts Spike 2's recorded proof and stores what it lists; refuses a wrong URL, method, header, body, key, parse path, conditions or mode, a proof older than an hour or from the future, an unsigned or re-signed proof, and both byte-shift attacks; reads a lower-case or checksummed address; a non-address value is refused. Gateway (fake Primus, fake chain): a proposal's check moves `checking` → `verified` / `not_listed` / `unavailable` (no website, no file, Primus error, timeout, no keys); approve actions wait while checking; `set_supplier` binds the proof only when it lists the proposed address; an address change checks the website on file, not the proposal's; the same URL within 10 minutes is one Primus call; a stale proof says stale; a changed-address hold shows the site's address; the daily re-check holds a payment with `website_changed` and lets payments go on once the file lists the address again; judge setup carries Kalibre's proof.

## Manual testing (Monad testnet, a few proofs)

Deploy the registry; set the Primus keys on Railway's gateway. Propose Q-2210 (Kalibre, listed) and Q-2211 (poisoned, not listed) for the main account; propose Northwind's quote and approve it with the passkey: `SupplierSet` names a proof hash the registry recorded. A changed-address invoice: the page says the site lists the address on file. Change a test file to another address: the next payment is held `website_changed`.

## Limits, stated

- **A compromised supplier website defeats it** (already in the architecture). It is one signal on the page, never a guarantee.
- **A new supplier's website comes from the quote.** A hijacked agent can propose a fraudster's site that lists the fraudster's address; the page shows the domain, and the owner judges it. For a supplier already on file, the site on file is used.
- **Primus and HTTPS are trusted** for the proof (S2-3). Primus's quota and pricing for the Core SDK are not published; each proof is one attestation.

## Decisions (made 8 Oct)

| # | Decision | Decided |
|---|---|---|
| S15-1 | Where the proof is checked on Monad | A separate registry, not inside the account: no account redeploy, existing accounts keep working, and the owner's `SetSupplier` signature binds the proof hash |
| S15-2 | What is recorded | Every genuine proof, matching or not, with the address the file lists read on chain (any letter case: addresses are compared as bytes, S2 finding 4) |
| S15-3 | Proof ages | Recorded only within an hour of Primus signing it; shown as stale after 24 hours (S2-4) |
| S15-4 | Which website | A new supplier: the proposal's, shown by domain. A supplier on file: the one on file, never a new proposal's |
| S15-5 | Approving while the check runs | Approve actions wait up to 60 s; then `unavailable` and the page says so |
| S15-6 | Primus calls | One per URL per 10 minutes, per gateway |
| S15-7 | Where Primus runs | Inside the gateway (Core SDK, WebAssembly build); the keys only on Railway's gateway and in `.env` |
| S15-8 | Evidence that expires | A daily re-check; a supplier whose site stops listing the address on file has its payments held (`website_changed`) until it lists it again |

## Next

Slice 16 (the 200-payment run), which needs MON.
