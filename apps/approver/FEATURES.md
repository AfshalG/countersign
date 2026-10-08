# What the app needs: one screen per feature

The approver app is how a person uses Countersign. Everything below already works on the backend or is being built now. Each feature lists what the screen is for, the API that feeds it and sample data from Monad testnet. **The look, layout and flow are yours (Sophie's).** This file only says what each screen has to do and what data it gets.

This file is kept in step with the code: when a feature lands or an API changes, it is updated here in the same change. Check **What changed** first.

## What changed

| Date  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7 Oct | First version. Approvals API live; sample approvals below; sign-in for agent apps built (WorkOS, waiting on the account)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7 Oct | A hold for an address that is not on file offers only **refuse** (`summary.payOnce: "address_not_on_file"`): the contract never pays a new address, not even for the owner                                                                                                                                                                                                                                                                                                                                                                                            |
| 7 Oct | Sign-in for agent apps is live: claude.ai, Grok and ChatGPT can connect to the MCP server by signing in (feature 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7 Oct | **Judge mode is live (feature 7):** any phone's new passkey gets its own testnet account, so your own Face ID works end to end. The "Coming next" list is renumbered                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7 Oct | **Demo invoices are live (feature 7, step 6):** the demo agent pays a clean, a changed-address or an amount-hold invoice into your own account; your Face ID decides the held ones                                                                                                                                                                                                                                                                                                                                                                                    |
| 7 Oct | **Approving proposals is live (feature 2):** add the supplier and open the order with two Face ID signatures, or refuse with one. Removed from "Coming next"                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7 Oct | **The stop button is live (feature 9):** pause and unpause the account with Face ID. Removed from "Coming next"                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7 Oct | Every payment names the agent that sent it (ERC-8004 id); agents on A2A can connect too (feature 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7 Oct | **Several approvers are live (new feature 8):** an account can have up to five owners, and adding a supplier can need two of them. Every action now says `signatures: { need, signed }`; a signature that is not yet enough answers `202`. The demo account moved to `0xC127…03A9`                                                                                                                                                                                                                                                                                    |
| 7 Oct | **The supplier demo site is live (feature 10):** Kalibre Studio's quotes and invoices and a demo shop's checkout, clean and doctored, for any account. Removed from "Coming next"                                                                                                                                                                                                                                                                                                                                                                                     |
| 7 Oct | **The real invoice checker is live:** holds now come from a checker that read the invoice (a line not on the order, a price above the quote, instructions hidden for an automated reader). Its findings are in each payment's `evidence` (feature 1). New reason `hidden_instructions`                                                                                                                                                                                                                                                                                |
| 8 Oct | **Connect WhatsApp (new, coming next 11):** a person can get held payments and proposed suppliers on WhatsApp, with a button back to the approval page; the app needs a "Connect WhatsApp" button (Face ID signs, then WhatsApp opens with the code typed). Agents in Claude Code now also ask the person in the chat, with the same approval link: nothing changes for the app. Audit record is now 12                                                                                                                                                               |
| 8 Oct | **Developers' test accounts (feature 7, nothing new to build):** `POST /v1/demo/accounts` takes an optional `agent` (a developer's own agent key), and every account view now has `agent: { address, hosted }`. Judge mode in the app sends no `agent` and works as before; `hosted: false` accounts are refused demo invoices (`409 not_hosted`). New `GET`/`POST /v1/demo/accounts/{account}/token`: the owner's passkey gets a token that reaches only that account (for developers, not the app)                                                                  |
| 8 Oct | **The supplier's own website, proven (Slice 15, features 1 and 2):** a proposal's view has `summary.websiteProof`: `status` (`checking`, `verified`, `not_listed`, `stale`, `unavailable`), `site` (the domain), `listed`, `checkedAt`, `text` (plain words to show), `proofHash` and `txHash` (the record on Monad). While it is `checking` (about 10 s) only refuse is offered. A changed-address hold has it too, with `matches` (`on_file`, `invoice`, `neither`). New hold reason `website_changed`: the supplier's own site stopped listing the address on file |

## What the product is, in one paragraph

A business lets an AI agent (Grok, Claude, ChatGPT and dots, Muse) pay its suppliers in USDC on Monad. Before any payment goes out, Countersign checks it against what the business approved: the supplier, the address on file, the order and the amount. A payment that matches is paid in about a second with nobody asked. One that doesn't is **held**, and the owner decides on their phone with Face ID, fingerprint or screen lock (a passkey). The contract checks that passkey itself, so not even our server can pay a held payment without the owner. The app is where the owner sees the holds, decides, and sees the proof.

## Rules for every screen (product rules, not design)

- **Phone first** (iPhone and Android), also works on a laptop. A web app, installable to the home screen; no app store.
- **Money is USDC**, shown as dollars with "USDC" after the number (`formatUsdc` in `@countersign/shared`). Never mention gas, MON, wallets or seed phrases: the owner never needs them, because the gateway pays the network fees.
- **When two addresses differ, show both in full** and make the different characters easy to see. The attack is a look-alike address, and the short `0x1234…abcd` form hides exactly the part an attacker changes.
- **Plain words for reasons**: use `reasonText` from the API (or `REASON_TEXT` in `@countersign/shared`), not the code (`address_mismatch`).
- **Refuse is a safe, equal choice**, never a small grey link. A refusal stops the agent's run.
- **There is no "pay the new address anyway".** The contract pays only the supplier's address on file, even with the owner's passkey. A changed address can only be refused; paying a new address means changing the supplier's address first (feature 2, an approved proposal), which then waits out a waiting period.
- **Never put the gateway's service token in the browser.** The approvals routes need no token (the passkey is the authorisation). Routes marked _token_ are called from this app's server (Next.js route handlers) with `GATEWAY_TOKEN` from the environment.

## Live now: build these

### 1. Approve or refuse a held payment (the most important screen)

What the owner sees when a payment is held: what it is, why it was held, the difference, and the choices: pay once or refuse when the address is the one on file; only refuse when it is not.

- `GET /v1/approvals/{id}` (no token) returns `title`, `status`, `summary` (`amountUsdc`, `payTo`, `addressOnFile`, `reason`, `reasonText`, `deadline`, `txHash`), `differences[]` (`field`, `onFile`, `onInvoice`), `actions` (each with the `challenge` the passkey signs: `refuse` always, `pay_once` only when `summary.payOnce` is `"offered"`; it is `"address_not_on_file"` when the address changed), and `statusUrl`.
- To decide: sign `actions[action].challenge` with the passkey (`WebAuthn.sign` from `ox`, see `spikes/01-passkey/public/index.html`), then `POST /v1/approvals/{id}` with `{ action, assertion }`. The assertion can be what `ox` returns (`authenticatorData`, `clientDataJSON`, `signature: { r, s }`) or the raw browser response; the gateway works out the rest.
- Answers: `200` with the new status (`released`, then `settled` about a second later with `txHash`; or `refused`). `422 challenge_mismatch` (signed the other action), `422 invalid_passkey` (not the owner's passkey), `422 not_offered` (pay once on a changed address), `409 not_held` (already decided), `404`.
- **What the checker found** (the approval sheet's "why"): `GET /v1/payments/{id}` (_token_, from this app's server) has `evidence`: `read` (the invoice's number, sender, lines, total and printed address as the checker read them, and any `hiddenText`), `findings` (each code check, `ok`, and a sentence, for example `"Product photos, white background" at 0.00018 USDC; the quote says 0.0001 USDC`), and `model` (the questions Jev was asked and its answers, each the probability of yes, 0 to 1; a hold from the model, such as a line the order does not cover, shows there). Show the failing finding, or the answer that held it, next to the difference; `reasonText` is the headline. A hold the contract made (a changed address) has the contract's reason and no checker findings.
- **Several owners (feature 8):** each action has `signatures: { need, signed }`. `pay_once` needs the account's release threshold (`need: 2` means two people); `refuse` always needs one. When this signature is not yet enough, the answer is `202` with the same view and `signed` now listing this owner: show "1 of 2 signed, waiting for another owner", and let them share the approval link. The second owner opens the same link and signs the same challenge.
- **What the supplier's own website lists** (`summary.websiteProof`, Slice 15) on a changed-address hold, and on a `website_changed` hold: `matches` is `on_file` ("still lists the address on file, not the invoice's": the invoice's address is not the supplier's), `invoice` (the site now lists the invoice's address: the supplier may really have changed it, so the owner changes it on file first, with a proposal), or `neither`. `text` says it in plain words. `checking` for a few seconds the first time.
- After paying: poll `GET /v1/approvals/{id}` until `settled`, then link the transaction: `https://testnet.monadexplorer.com/tx/{txHash}`.
- Sample (held, the invoice's address is not the one on file: `differences[]` filled, only `refuse` offered): `https://gateway-production-e17a.up.railway.app/v1/approvals/0xc25803b4f8c7da43dcea7a4c702a372fad0f61afe1bb8c78ba9c24e2b26cf367`
- Sample (held for its amount, address on file: `pay_once` and `refuse` offered): `…/v1/approvals/0xc4c8e89bf4019f8161394a7ee8f8342ea64f796e0e90b6d13155331f9152c6ab`
- **Testing with your own phone:** the samples belong to the demo account, whose owner passkey is a test key, so your Face ID gets `422 invalid_passkey`. That is correct, and it proves the passkey check works. For your own phone end to end, create your own account (feature 7).

### 2. A proposed supplier and order (approve or refuse)

When an agent reads a supplier's quote, it can only _propose_ the supplier and the order; nothing is real until the owner approves with Face ID.

- `GET /v1/approvals/{id}` with `kind: "proposal"`. `summary`: `supplierName`, `website`, `payTo`, `amountUsdc`, `expiry`, `addressOnFile` (null for a new supplier), `changesAddress`, `accountUsdc`, `enoughFunds`, `waitingPeriodSeconds`, `signBy`.
- `actions`, each with `challenge` and a plain `summary` to show while asking for Face ID:
  - `set_supplier` ("Add Northwind Prints as a supplier, paid only at 0x…"): only when the supplier is not on file at this address;
  - `approve_order` ("Open an order with Northwind Prints for 0.002 USDC");
  - `refuse` ("nothing is added and no money moves").
- Approve: sign each offered approve action, then `POST /v1/approvals/{id}` with `{ "action": "approve", "assertions": { "set_supplier": a1, "approve_order": a2 } }`. About 3 s; the answer has `status: "approved"`, and the order appears in the agent's open orders.
- Refuse: `{ "action": "refuse", "assertion": a }`.
- **Several owners (feature 8):** `set_supplier` and `approve_order` need the manage threshold (`signatures.need`); refusing needs one. The first owner's approve answers `202` with the proposal still `pending` and `signed: [0]`; when the next owner approves, both actions go out (about 3 s) and the answer is `200`, `approved`.
- **A changed address** (`changesAddress: true`, `differences[]` filled): approving changes the supplier's address for every order, and new payments to it wait out the waiting period. Make that unmistakable.
- **The supplier's own website** (`summary.websiteProof`, Slice 15): Countersign reads `https://<site>/.well-known/countersign.json`, Primus proves what it lists, and the proof is recorded on Monad. Show `text` and the `site` domain prominently: `verified` ("northwind-prints-demo.vercel.app lists this address"), `not_listed` (it lists `listed` instead: a strong warning), `stale` (over a day old), `unavailable` (no website, no file, or it could not be proven: "confirm the address with the supplier yourself"), `checking` (poll every second or two; only refuse is offered until it ends, at most a minute). For a new supplier the site comes from the quote (`source: "proposal"`), so a fraudster can name their own site: the domain is what the owner should judge. For a supplier already on file the site on file is used (`source: "on_file"`). Approving a `verified` one puts the proof in the supplier record on chain. `null` for proposals made before 8 Oct.
- **Not enough USDC** (`enoughFunds: false`): only refuse is offered; say how much is missing (`amountUsdc` against `accountUsdc`).
- Errors: `422 challenge_mismatch` or `invalid_passkey`, `409 not_pending`, `insufficient_funds`, `expired` or `stale` (the account changed since you opened it: open it again).
- Try it: create your own account (feature 7), then ask an agent with the MCP tool `propose_order`, or have Afshal run `pnpm --filter @countersign/gateway proposal-smoke`.

### 3. A payment's record (the proof)

One payment as evidence: what was asked, what was checked, who decided, and the transaction on Monad.

- `GET /v1/approvals/{id}` (no token) for the basics; `GET /v1/payments/{id}` (_token_) adds the evidence, timings and transaction.
- Today's plain version, rendered by the gateway, which yours replaces: `https://gateway-production-e17a.up.railway.app/p/{id}`.

### 4. Suppliers and orders

Each supplier's address on file and its open orders, with how much is left.

- `GET /v1/accounts/{account}/orders` (_token_): supplier, address on file, amount left, expiry. Demo account: `0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9`.

### 5. Live updates and the payment run

An agent can hand over a whole run (up to 500 invoices). The owner watches them get checked and paid live; held ones stand out.

- `GET /v1/feed` (_token_, Server-Sent Events, event `status`): every status change as it happens. Proxy it through this app's server.
- `GET /v1/runs/{id}` (_token_): counts by status and every request in the run.
- Sample run: not yet. A run spends testnet MON, which is being topped up; one will be added here.

### 6. Connect your agent

For judges and developers: how to connect an agent to Countersign.

- MCP server: `https://countersign-mcp.vercel.app/api/mcp`. claude.ai, Grok and ChatGPT connect by adding it as a custom connector and signing in (Google, Microsoft, GitHub, Apple or email); Claude Code and Codex can also use a token.
- A2A (Google's Agent2Agent protocol): the Agent Card at `https://countersign-mcp.vercel.app/.well-known/agent-card.json`; a held payment comes back as an `auth-required` task with the approval link.
- Every payment names the agent that sent it (`agent.agentId`, its ERC-8004 id: 2066 is Countersign's hosted agent, 2067 judge mode's demo agent). Show it on the payment's record (feature 3).
- SDK and quickstart: `docs/developers/quickstart.md`, `packages/sdk/README.md`. API reference: `https://gateway-production-e17a.up.railway.app/docs`.

### 7. Your own account (judge mode)

Anyone, a judge or you, gets their own testnet account from their phone's passkey and tries the whole flow with their own Face ID. Nothing to install, no wallet, no MON.

1. **Create a passkey** on the phone (`WebAuthnP256.createCredential` from `ox`, as in `spikes/01-passkey`, or `navigator.credentials.create`). It must be **P-256** (`pubKeyCredParams: [{ type: 'public-key', alg: -7 }]`) with **user verification required**; the contract refuses anything else.
2. `POST /v1/demo/accounts` (no token) with `{ "publicKey": { "x": "0x…", "y": "0x…" } }`, or `{ "publicKey": { "spki": "<base64url>" } }` as `response.getPublicKey()` gives it. About 3 s: the account is created and funded with 0.01 USDC. The same passkey always gets the same account.
3. The answer has `actions`: three things to sign, in order, each with a `summary` in plain words ("Add Kalibre Studio as a supplier, paid only at 0x90f9…", "Open an order with Kalibre Studio for 0.005 USDC") and the `challenge` to sign. That is three Face ID prompts; show each summary as you ask.
4. `POST /v1/demo/accounts/{account}/setup` with `{ "assertions": [a1, a2, a3] }`, each in the same shape as for approvals. About 3.5 s; the answer has `status: "ready"` and the `order`.
5. `GET /v1/demo/accounts/{account}` shows where it is at any time (`awaiting_passkey`, `setting_up`, `ready`).

- Errors: `400 invalid_public_key` or `malformed_assertion`, `404`, `409 not_created` or `contract_refuses`, `422 challenge_mismatch` (signed in the wrong order) or `invalid_passkey`, `429 demo_limit` (10 new accounts a day).
- Say on screen that demo accounts have **no waiting period** for new suppliers, so they can pay at once; real accounts wait 48 hours.

6. **Have the demo agent pay an invoice into your account**: `POST /v1/demo/accounts/{account}/invoices` (no token) with `{ "kind": "clean" }`, `"changed_address"` or `"amount_mismatch"`. 0.001 USDC each, from your 0.005 order (so up to five paid). The answer has `status`, `reasonText`, `txHash`, `statusUrl`, and `approvalUrl` when it is held.
   - `clean`: settles in about 1.7 s. Show the transaction.
   - `changed_address`: held, the invoice's address is a look-alike (same first six and last four characters as Kalibre's). Only **refuse** is offered: show both addresses in full so the difference is visible.
   - `amount_mismatch`: held; **pay once** or **refuse** with your own Face ID (feature 1's screen, on `approvalUrl`). Paid once, it settles about 1.4 s later. (Held by the invoice checker: it bills 0.00012 USDC a photo against the quote's 0.0001.)
   - `409 order_used_up` once the order has nothing left; `409 not_ready` before setup. Right after setup the order can take a few seconds to be indexed: the gateway waits up to 15 s, then answers `409 order_not_indexed` (try again shortly).

### 9. The stop button (pause and unpause)

One tap stops every payment from the account, until the owner starts it again. A payment that arrives while paused is held ("The owner has paused the account."); after unpausing, it can be paid once from its approval (feature 1).

- `GET /v1/owner/{account}` (no token): `paused`, and `actions` with the one action that changes it (`pause` or `unpause`): its `challenge`, `deadline` and `summary` ("Stop every payment from this account until you unpause it").
- `POST /v1/owner/{account}` with `{ "action": "pause", "deadline": <as shown>, "assertion": a }`. About 1.3 s; the answer is the new state.
- Errors: `409 already_paused`, `not_paused` or `stale` (open it again), `400 bad_deadline` (sign within ten minutes of opening), `422 challenge_mismatch` or `invalid_passkey`.
- Make it easy to find and hard to hit by accident; show clearly when the account is paused.
- **Several owners (feature 8):** any one owner can pause. Unpausing needs the manage threshold: with two needed, the first owner's unpause answers `202` (still paused, `actions.unpause.signatures.signed: [0]`), and the view keeps offering the same challenge and deadline (a day to sign) until the next owner signs it.

### 8. Several approvers (owners and thresholds)

A business does not let one person add a supplier or change bank details alone. An account can have up to five owners, each with their own passkey, and two thresholds: **manage** (add or change a supplier, open an order, change the rules or the owners, unpause) and **release** (pay a held payment once). Any one owner can always **pause** or **refuse**, because stopping money must never wait for a second person. New accounts start with one owner, so nothing changes until a second is added.

- `GET /v1/owner/{account}` (no token) now also has `owners` (`[{ owner: 0, qx, qy }, …]`; signatures name owners by this index), `manage`, `release`, and `ownerChanges`: changes some owners have signed, waiting for the others (each with its `challenge`, `deadline`, `summary`, `owners`, `manage`, `release` and `signatures`).
- Owners have no names on chain. Remember on the phone which owner is "you" (the public key of the passkey this phone made) and let the owner name the others locally.
- **Add an approver:**
  1. The new person creates a passkey on their own phone (as in feature 7, step 1) and passes its public key to the owner (a QR code or a link; the key is public, not a secret).
  2. `POST /v1/owner/{account}/owners/preview` (no token) with every owner after the change, current ones first, and the thresholds: `{ "owners": [{ "x": "0x…", "y": "0x…" }, { "spki": "…" }], "manage": 2, "release": 1 }`. The answer has `challenge`, `deadline`, `summary` in plain words ("2 owners. Adding or changing a supplier, … need 2 of their passkeys; …") and `signatures`.
  3. Each current owner signs that `challenge`, then `POST /v1/owner/{account}/owners` with the same `owners`, `manage`, `release`, plus `deadline` and `assertion`. `200` when it went out (the answer is the account with its new owners), `202` while more current owners must sign (they find it in `ownerChanges`).
- Remove an owner by leaving them out; change the thresholds the same way.
- Errors: `400 bad_owners` (none, more than five, the same passkey twice, or a threshold of 0 or more than the owners), `400 invalid_public_key`, `400 bad_deadline`, `422 challenge_mismatch` or `invalid_passkey`, `409 stale` (the account changed: preview again).
- **The waiting state is the new screen:** "1 of 2 signed": who signed, who still needs to, and a way to send the link to them. It appears on held payments, proposals, unpausing and owner changes.
- **Try it with one phone:** make a second passkey on the same phone for your judge account (another account name in the passkey prompt), add it with manage 2, then ask the agent to propose a supplier: the first Face ID answers 202, the second approves it. Pausing still takes one.

### 10. The supplier demo site (Kalibre Studio and a demo shop)

Not a screen in this app: a separate site, as a real supplier would publish it, with the documents an agent reads and tries to pay. It is plain on purpose; restyle it if you like (`apps/supplier/lib/render.ts`).

- `https://countersign-supplier-demo.vercel.app/demo?account=0x…` lists every case for an account: a quote, a poisoned quote, a clean invoice, a changed address (a look-alike), a padded line, a padded total, a hidden instruction to pay elsewhere, the wrong supplier, more than the order, a bank transfer, and a shop's checkout clean and swapped. Each says what Countersign does with it today.
- Every document also comes as `?format=text` (what an agent's page reader sees, hidden text included) and `?format=json`.
- Kalibre's payment address file, the one the Primus proof covers: `/.well-known/countersign.json`.
- Not built: the site showing "paid" arriving. It would read Kalibre's USDC transfers on Monad (public data, no token needed); ask Afshal if you want it for the demo.

## Coming next: design now, the API lands here

| #   | Feature          | What the screen does                                                                                                                                                                                                                                                                                                  | API (when it lands)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 11  | Connect WhatsApp | A button on the account screen. Face ID signs, then WhatsApp opens with `CONNECT <code>` typed; the person sends it. From then on, every held payment and proposed supplier arrives on WhatsApp with a "Review and decide" button that opens `/p/<id>` (the same approval page). Sending STOP in WhatsApp disconnects | Built (Slice 14), live once Countersign's WhatsApp number is set up: `POST /v1/whatsapp/codes` `{ account }` → `{ code, challenge, expiresAt }`; sign `challenge` with the passkey (exactly as for refusing a proposal); `POST /v1/whatsapp/codes/{code}` `{ assertion }` → `{ link, text, number, expiresAt }`; open `link` (wa.me). The code lasts 15 minutes. Errors: `invalid_passkey` (422), `code_expired` / `code_used` (409), `too_many_codes` (429) |
| 12  | Audit record     | Download a payment's record for an auditor                                                                                                                                                                                                                                                                            | Slice 18                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
