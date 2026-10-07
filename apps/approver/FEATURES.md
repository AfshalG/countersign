# What the app needs: one screen per feature

The approver app is how a person uses Countersign. Everything below already works on the backend or is being built now. Each feature lists what the screen is for, the API that feeds it and sample data from Monad testnet. **The look, layout and flow are yours (Sophie's).** This file only says what each screen has to do and what data it gets.

This file is kept in step with the code: when a feature lands or an API changes, it is updated here in the same change. Check **What changed** first.

## What changed

| Date  | Change                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7 Oct | First version. Approvals API live; sample approvals below; sign-in for agent apps built (WorkOS, waiting on the account)                                                   |
| 7 Oct | A hold for an address that is not on file offers only **refuse** (`summary.payOnce: "address_not_on_file"`): the contract never pays a new address, not even for the owner |
| 7 Oct | Sign-in for agent apps is live: claude.ai, Grok and ChatGPT can connect to the MCP server by signing in (feature 6)                                                        |

## What the product is, in one paragraph

A business lets an AI agent (Grok, Claude, ChatGPT and dots, Muse) pay its suppliers in USDC on Monad. Before any payment goes out, Countersign checks it against what the business approved: the supplier, the address on file, the order and the amount. A payment that matches is paid in about a second with nobody asked. One that doesn't is **held**, and the owner decides on their phone with Face ID, fingerprint or screen lock (a passkey). The contract checks that passkey itself, so not even our server can pay a held payment without the owner. The app is where the owner sees the holds, decides, and sees the proof.

## Rules for every screen (product rules, not design)

- **Phone first** (iPhone and Android), also works on a laptop. A web app, installable to the home screen; no app store.
- **Money is USDC**, shown as dollars with "USDC" after the number (`formatUsdc` in `@countersign/shared`). Never mention gas, MON, wallets or seed phrases: the owner never needs them, because the gateway pays the network fees.
- **When two addresses differ, show both in full** and make the different characters easy to see. The attack is a look-alike address, and the short `0x1234…abcd` form hides exactly the part an attacker changes.
- **Plain words for reasons**: use `reasonText` from the API (or `REASON_TEXT` in `@countersign/shared`), not the code (`address_mismatch`).
- **Refuse is a safe, equal choice**, never a small grey link. A refusal stops the agent's run.
- **There is no "pay the new address anyway".** The contract pays only the supplier's address on file, even with the owner's passkey. A changed address can only be refused; paying a new address means changing the supplier's address first (feature 7), which then waits out a waiting period.
- **Never put the gateway's service token in the browser.** The approvals routes need no token (the passkey is the authorisation). Routes marked _token_ are called from this app's server (Next.js route handlers) with `GATEWAY_TOKEN` from the environment.

## Live now: build these

### 1. Approve or refuse a held payment (the most important screen)

What the owner sees when a payment is held: what it is, why it was held, the difference, and the choices: pay once or refuse when the address is the one on file; only refuse when it is not.

- `GET /v1/approvals/{id}` (no token) returns `title`, `status`, `summary` (`amountUsdc`, `payTo`, `addressOnFile`, `reason`, `reasonText`, `deadline`, `txHash`), `differences[]` (`field`, `onFile`, `onInvoice`), `actions` (each with the `challenge` the passkey signs: `refuse` always, `pay_once` only when `summary.payOnce` is `"offered"`; it is `"address_not_on_file"` when the address changed), and `statusUrl`.
- To decide: sign `actions[action].challenge` with the passkey (`WebAuthn.sign` from `ox`, see `spikes/01-passkey/public/index.html`), then `POST /v1/approvals/{id}` with `{ action, assertion }`. The assertion can be what `ox` returns (`authenticatorData`, `clientDataJSON`, `signature: { r, s }`) or the raw browser response; the gateway works out the rest.
- Answers: `200` with the new status (`released`, then `settled` about a second later with `txHash`; or `refused`). `422 challenge_mismatch` (signed the other action), `422 invalid_passkey` (not the owner's passkey), `422 not_offered` (pay once on a changed address), `409 not_held` (already decided), `404`.
- After paying: poll `GET /v1/approvals/{id}` until `settled`, then link the transaction: `https://testnet.monadexplorer.com/tx/{txHash}`.
- Sample (held, the invoice's address is not the one on file: `differences[]` filled, only `refuse` offered): `https://gateway-production-e17a.up.railway.app/v1/approvals/0xcfe2b4280875a01f90ea59c7d5d963b63594b8c0b9629ad4e453e9f20516625c`
- Sample (held for its amount, address on file: `pay_once` and `refuse` offered): `…/v1/approvals/0xa5a1f6754338df015835ae6697e72a14217ac1b643cdbe8091b63c987baf7a0a`
- **Testing with your own phone:** the samples belong to the demo account, whose owner passkey is a test key, so your Face ID gets `422 invalid_passkey`. That is correct, and it proves the passkey check works. The full flow with your own phone comes with feature 9 (an account for your passkey).

### 2. A proposed supplier and order (view now, approve soon)

When an agent reads a supplier's quote, it can only _propose_ the supplier and the order; nothing is real until the owner approves.

- `GET /v1/approvals/{id}` with `kind: "proposal"`: `summary` has `supplierName`, `website`, `payTo`, `amountUsdc`, `expiry`. `actions` is empty until feature 7 lands.
- Sample (pending): `…/v1/approvals/0xb4ce00179b493b9590a242fb8fd0309a5fc1140584945a57358414efca8aea1b`

### 3. A payment's record (the proof)

One payment as evidence: what was asked, what was checked, who decided, and the transaction on Monad.

- `GET /v1/approvals/{id}` (no token) for the basics; `GET /v1/payments/{id}` (_token_) adds the evidence, timings and transaction.
- Today's plain version, rendered by the gateway, which yours replaces: `https://gateway-production-e17a.up.railway.app/p/{id}`.

### 4. Suppliers and orders

Each supplier's address on file and its open orders, with how much is left.

- `GET /v1/accounts/{account}/orders` (_token_): supplier, address on file, amount left, expiry. Demo account: `0xE890B35be32F04032B502Dc4Dc2db8062aD6d603`.

### 5. Live updates and the payment run

An agent can hand over a whole run (up to 500 invoices). The owner watches them get checked and paid live; held ones stand out.

- `GET /v1/feed` (_token_, Server-Sent Events, event `status`): every status change as it happens. Proxy it through this app's server.
- `GET /v1/runs/{id}` (_token_): counts by status and every request in the run.
- Sample run: not yet. A run spends testnet MON, which is being topped up; one will be added here.

### 6. Connect your agent

For judges and developers: how to connect an agent to Countersign.

- MCP server: `https://countersign-mcp.vercel.app/api/mcp`. claude.ai, Grok and ChatGPT connect by adding it as a custom connector and signing in (Google, Microsoft, GitHub, Apple or email); Claude Code and Codex can also use a token.
- SDK and quickstart: `docs/developers/quickstart.md`, `packages/sdk/README.md`. API reference: `https://gateway-production-e17a.up.railway.app/docs`.

## Coming next: design now, the API lands here

| #   | Feature                      | What the screen does                                                                                                         | API (when it lands)                                       |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 7   | Approve a proposal           | Approve a proposed supplier and order: two passkey signatures in a row (add the supplier, then fund the order)               | `actions.approve` on the proposal's approval              |
| 8   | Pause and unpause            | The stop button: stop all payments from the account at once, and start again                                                 | approval-style actions, signed with the passkey           |
| 9   | Judge mode: your own account | Create a passkey on the phone, get an account with test USDC and a demo order, then try the whole flow with your own Face ID | `POST /v1/demo/account` with the new passkey's public key |
| 10  | Supplier demo site           | A separate supplier's site (Kalibre Studio) that issues quotes and invoices, clean and doctored, and shows "paid" arriving   | Slice 7                                                   |
| 11  | Audit record                 | Download a payment's record for an auditor                                                                                   | Slice 18                                                  |

## Where to look in the repo

| What                                                                                    | Where                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Running this app                                                                        | `apps/approver/README.md`                                                                        |
| Every API route, field and error, generated from the code                               | `https://gateway-production-e17a.up.railway.app/docs` (and `/openapi.json` for generating types) |
| Shared types and wording: statuses, reasons, `REASON_TEXT`, `formatUsdc`, EIP-712 types | `packages/shared/src`                                                                            |
| A working passkey page (create and sign, tested on iPhone, Android and Mac)             | `spikes/01-passkey/public/index.html`                                                            |
| An approval end to end in code: fetch, sign, post, wait                                 | `services/gateway/scripts/approvals-smoke.ts`                                                    |
| How the approvals work, and what is built next                                          | `docs/plan/slice-09-passkey-owner.md`                                                            |
| The whole product: decisions, slices, status                                            | `docs/plan/00-architecture.md`                                                                   |
| What is proven, with links to the evidence                                              | `README.md` ("What works today", "Security model")                                               |

New sample approvals: ask Afshal. They come from `pnpm --filter @countersign/gateway sample-approvals`, which needs the gateway's secrets.
