# Slice 11: The approver app

## Status

**BUILDING (8–9 Oct 2026).** Afshal (8 Oct, 11 PM): build Slice 11 now; Sophie restyles and extends it. Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). Owner: Sophie (D6), built by Claude for the deadline.

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

## Next

Slice 22.
