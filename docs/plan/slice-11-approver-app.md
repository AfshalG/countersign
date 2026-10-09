# Slice 11: The approver app

## Status

**BUILT (9 Oct 2026), live at https://countersign-approver.vercel.app; the Face ID flows wait for a test on a phone.** Afshal (8 Oct, 11 PM): build Slice 11 now; Sophie restyles and extends it. Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). Owner: Sophie (D6), built by Claude for the deadline.

## Goal

The owner's side of Countersign on a phone (D1, D20): every decision an owner makes, made with Face ID, against the gateway's live API. Until now the only screens were the gateway's own read-only pages (`/p/{id}`, `/r/{runId}`), so nothing on screen could take a decision: the demo's central moment (a held payment, decided with Face ID) had no screen.

## Screens (from `apps/approver/FEATURES.md`, in the order the demo needs them)

| # | Screen | Route | API |
|---|---|---|---|
| 1 | A held payment: the reason, both addresses in full with the differences marked, what the checker found; pay once or refuse with Face ID; "1 of 2 signed" | `/approve/[id]` | `GET/POST /v1/approvals/{id}`; `GET /v1/payments/{id}` (token) |
| 2 | A proposed supplier and order: the supplier's website proof; approve (two signatures) or refuse | `/approve/[id]` | the same, `kind: "proposal"` |
| 7 | Your own account (judge mode): a passkey, three setup signatures, the demo agent paying clean and doctored invoices | `/` and `/judge` | `/v1/demo/accounts…` |
| 5 | The run board: decided of size, paid, held by reason, time to final; refuse a reason's holds with one Face ID | `/runs/[id]` | `/r/{id}?format=json` (through the app's server: no CORS there), `/v1/approvals/runs/{runId}` |
| — | The inbox: held payments and proposals waiting | `/` | `GET /v1/accounts/{account}/inbox` (new, token) |
| 3 | A payment's record: the checks, who decided, the transactions on Monad, a download | `/record/[id]` | `GET /v1/payments/{id}/record` (token) |
| 9 | The stop button | `/account` | `GET/POST /v1/owner/{account}` |
| 8 | Several approvers: owners, thresholds, adding one | `/account` | `/v1/owner/{account}/owners…` |
| 4 | Suppliers and orders; a supplier's bank account on file | `/orders` | `GET /v1/accounts/{account}/orders` (token), `/v1/owner/{account}/banks…` |
| 6, 11 | Connect your agent; connect WhatsApp | `/connect` | static; `POST /v1/whatsapp/codes` |

## Decisions (made 8 Oct)

| # | Decision | Decided |
|---|---|---|
| S11-1 | How the app reaches token routes | An **account token**, got with one Face ID signature (`/v1/demo/accounts/{account}/token`), kept on the phone. It reaches only that account; the gateway's service token never reaches the browser |
| S11-2 | Passkeys | The browser's own WebAuthn: P-256 (`alg -7`), user verification required, discoverable. The gateway takes the browser's raw assertion (base64url, DER) and the vault checks it, so the app does no cryptography |
| S11-3 | Live updates | Polling (1 to 2 s) for the run board and the inbox; the SSE feed needs a proxy with the token, later |
| S11-4 | Styling | Plain and phone first, following FEATURES' rules; Sophie restyles |
| S11-5 | Hosting | Vercel, like the MCP server and the supplier site |

## Tests first

The pure parts: base64url and challenge bytes, the public key from `getPublicKey()`, marking the characters where two addresses differ, reading the gateway's answers and errors into plain words. The gateway's new inbox route against Postgres (an account's holds and pending proposals; another account's token refused). The screens by hand on a phone, against the live gateway.

## Built

Every screen in the table, against the live gateway: the inbox and judge mode (`/`), the approval sheet (`/approve/[id]`), the run board (`/runs/[id]`), the record (`/record/[id]`), the account (`/account`: stop button, approvers), suppliers and orders with the bank account on file (`/orders`), and connect (`/connect`). The gateway gained `GET /v1/accounts/{account}/inbox` and supplier names on orders.

**Signing exactly what is shown (9 Oct, after Afshal: scams are now "sometimes even invisible").** Before any Face ID the app recomputes the challenge from the typed data it came with (`lib/verify.ts`) and refuses a mismatch with nothing signed; "pay once" states the exact amount and address from that typed data. Checked against the live gateway's owner actions.

Found while building: the first merge went to `development` with CI failing (a CSS import that CI could not type, because Next's `next-env.d.ts` is not committed), because the merge script's `gh run watch … && echo` does not stop under `set -e`. Fixed in the app (`app/css.d.ts`) and in the script (it now waits on the CI run for the exact commit and stops on failure). Nothing was deployed from the red commit.

Tests: 8 for the app's pure parts (encoding, address differences, plain-word errors, signing what is shown), the gateway's inbox and order names; the screens checked at phone width in a headless browser.

**Afshal's first test on his phone (9 Oct, 1 AM): "laggy", the fingerprint asked again and again, and the app "has nothing".** The gateway's HTTP log showed why it had nothing: the browser's preflight for every token route (inbox, orders, banks, payments, records) was answered 401 by the token check, so the inbox stayed on "Reading…" and nothing loaded; the tests had called those routes from a server, never from a browser on another origin. Fixed: those routes answer the preflight and allow the `authorization` header (`services/gateway/test/record.test.ts`, "the approver app reaches its token routes from the browser"). The prompts: five by design (the passkey, three setup signatures, one for a token); setup now returns the phone's token, since its signatures already prove the passkey (checked off chain against the owner keys, only in the call that sets the account up), so four, and the app says before the first what each one approves. The three setup signatures are three owner actions in the contract (policy, supplier, order); one prompt for all three needs a batched owner action in the contract. The lag: creating the account took 4.6 s (the account, then its USDC); both are now sent at once (2.6 s live). Checked live with a software passkey: setup returned the token, a look-alike invoice was held, and the inbox read with the phone's token listed it. Still slow: a demo invoice sent the moment setup finishes waits for the order to reach the index (Monad's finalized blocks; 7.5 s once, 1.8 s on the phone 50 s later). The app also says when it cannot reach Countersign rather than "Reading…" forever.

## Next

Slice 22.
