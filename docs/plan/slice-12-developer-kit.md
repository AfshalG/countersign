# Slice 12: The developer kit

## Status

**DONE (7 Oct 2026).** Every manual step passed on Monad testnet; the SDK is released (`sdk-v0.1.1`), the MCP server is on Vercel, the gateway's reference is live. Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). Owners: Roshan (MCP server), Afshal (gateway); built by Claude.

## Goal

Make Countersign something other developers build on (D33, Track 04). A developer gives their agent a Countersign account instead of a card or a wallet key, three ways:

- **The SDK** (`@countersign/sdk`): a few lines in their own agent. The agent's key stays with them and signs locally.
- **The MCP server**: any MCP agent (Claude Code today; claude.ai, Grok and others after Slice 13's sign-in) gets six tools: propose an order, list open orders, check an invoice, pay one, pay a run, look up a status.
- **The web API**: the gateway's `/v1` routes, with a generated OpenAPI document and a reference page, for agents that speak neither.

Plus a quickstart a developer can follow in five minutes, and examples. Done when an outside developer can install the SDK from its release link and pay a testnet invoice through the hosted gateway, and Claude Code pays, holds and checks through the hosted MCP server.

## Prerequisites

- Slice 5 (done): the contracts, the EIP-712 types and fixtures in `packages/shared`, a funded order vault on testnet (`0x771d…7dC7`, 13,600 base units left after Slice 6).
- Slice 6 (done): the gateway on Railway (`https://gateway-production-e17a.up.railway.app`), its `/v1` API, the feed, the typed statuses and reasons.
- Slice 4 (built): the MCP server pattern on Vercel (`mcp-handler` 2.2.0 on MCP SDK v2 `@modelcontextprotocol/server` 2.3.1), Claude Code connected with a bearer token.
- Relayer MON: about 0.26 MON, enough for about 7 payments. The manual test spends at most 6.

## Cross-checked (7 Oct 2026)

| Source | What it settles |
|---|---|
| MCP TypeScript SDK v2 docs (Context7, ts.sdk.modelcontextprotocol.io/v2) | `registerTool(name, { title, description, inputSchema, outputSchema, annotations, _meta }, cb)`; `structuredContent` is validated against `outputSchema` before it leaves the server; annotations `readOnlyHint`, `destructiveHint` (default true), `idempotentHint` (default false), `openWorldHint` never change execution |
| Hono docs (Context7) and npm | `@hono/zod-openapi` 1.6.3 (peer zod ^4, hono >=4.10): `createRoute` + `OpenAPIHono.openapi()` validate with the same zod schemas that produce the document; `app.doc()` serves it. `@scalar/hono-api-reference` 0.12.10 serves a reference page |
| tsdown docs (Context7) and npm | tsdown 0.23.0: `entry`, `format: ['esm']`, `dts: true`, `exports: true` writes the package's `exports` field |
| Monad docs, RPC limits | `eth_getLogs`: 100 blocks per call on Monad's endpoint, 1,000 on Ankr; blocks every few hundred milliseconds. Orders are indexed from the finalized receipts the gateway already reads, never by scanning logs on demand |
| npm registry | The `@countersign` scope belongs to another project (D34): the SDK ships as a GitHub release tarball |

## Checked against earlier slices

| Slice | What carries into this one |
|---|---|
| 4 (connectors) | One MCP server on Vercel through `mcp-handler`; tools never wait on a person (Codex cuts tools at 60 s, claude.ai at 240 s); every held result carries the approval link in its text; tool hints. **Changed here:** pay tools do not set `anthropic/requiresUserInteraction`. Slice 4 planned it, but a prompt on every payment contradicts D32 and the pitch (the contract is the boundary; inside the rules the agent pays without a tap). They keep `destructiveHint: true` and `idempotentHint: true`, so a client that wants to ask still can |
| 5 (contracts) | `Payment { amount, invoiceHash, payTo, deadline }` in the vault's EIP-712 domain; the vault pays only its supplier's address on file (`PayToNotOnFile` otherwise); a new address is capped (`newAddressCap` for `newAddressPeriod`) and waits (`waitingPeriod`); `paid[invoiceHash]` stops a second payment within a vault. Events: `OrderApproved`, `OrderClosed`, `SupplierSet`, `PaymentExecuted` |
| 6 (gateway) | Request id = (account, vault, invoiceHash), so the tools are idempotent for free; statuses and reasons from `packages/shared`; the feed; the service token until Slice 13; **one gateway per relayer set** (never run a local gateway while Railway's is up); relayer gas about 0.027 MON per payment; the look-alike address is held (not blocked) so the owner sees both addresses |
| Spike 3 (S3-7) | Vaults are for isolation, not speed: the docs never credit vaults with speed |
| D32 | The contract is the security boundary; the checker is a measured detector. The docs say this plainly. SDK mode keeps the agent's key with the agent |
| D33 | SDK, MCP and web API with docs; another Metropolis team integrates during the hackathon |
| D34 | The name stays; the SDK ships as a GitHub release tarball |
| Money rules | Rule 2: the tools take the address as the agent read it from the invoice; the contract pays only the address on file, and a mismatch is held with both shown. Rule 5: every pay tool is idempotent. Rule 6: typed outcomes only. Rule 8: `propose_order` changes nothing until the owner's passkey signs |

## Design considerations

**1. Two modes, one API.** In **SDK mode** the developer's agent holds its agent key and the SDK signs each `Payment` locally; the gateway never sees the key. In **hosted mode** the MCP server holds the agent key for the account (an encrypted environment secret on Vercel; one demo account until Slice 13 adds per-account keys and sign-in). Both send the same request to the same gateway.

**2. The SDK** (`packages/sdk`, `@countersign/sdk`):

```ts
import { Countersign, usdc } from '@countersign/sdk';

const cs = new Countersign({ gateway, token, account, agentKey });
const orders = await cs.orders();                        // open orders, with what is left
const result = await cs.pay({
  order: orders[0].orderId,
  invoice: { number: 'INV-0042', amount: usdc('12.50'), payTo: '0x90f9…5fEc' },
  wait: true,                                            // until settled, held or blocked
});
// result.status: 'settled' | 'held' | 'blocked' | …, result.reason, result.approvalUrl, result.tx
```

`check()`, `payMany()` (a run), `watch(runId)` (an async iterator over the feed), `status(id)`, `proposeOrder()`. Typed errors (`CountersignError` with the gateway's `error` code and field issues). Amounts are decimal strings or bigints, never floats (`usdc('12.50')` is 12,500,000 base units). Built with tsdown to ESM with type declarations; `viem` is its one runtime dependency (signing). Works in Node 22+, Bun, Deno and edge runtimes (fetch only).

**3. The invoice's identity.** `invoiceHash = keccak256(abi.encode(supplierId, normalized invoice number))`, normalized as NFKC, trimmed, inner whitespace collapsed, upper case. The same supplier's same invoice number gives the same hash in any order, so a resent invoice is the same request (gateway) and cannot be paid twice in one order (vault); across orders the checker catches it (Slice 10). Test vectors live in `packages/shared` so the SDK, the MCP server and the checker agree.

**4. Gateway additions.**
- **OpenAPI.** Routes move to `@hono/zod-openapi`'s `createRoute`, so the validation schemas also produce `/openapi.json`, and `/docs` serves a Scalar reference page. Existing behaviour and tests unchanged.
- **`POST /v1/checks`.** The full check (contract rules by simulation, then the checker) with no payment and nothing stored: `would_settle`, `held` or `blocked`, with the reason and evidence. For bank-transfer invoices and dry runs.
- **Orders index.** `accounts` and `orders` tables. The finality tracker already reads every finalized block's receipts; it now also records `OrderApproved`, `OrderClosed` and `SupplierSet` from registered accounts, and `PaymentExecuted` updates what is left. On start it resumes from the last indexed block with `eth_getLogs` windows sized to each endpoint's limit. `GET /v1/accounts/:account/orders` lists open orders with supplier, address on file, amount left and expiry. `POST /v1/accounts` registers an account (service token; Slice 13 ties it to a sign-in).
- **Proposals.** `POST /v1/proposals` stores a proposed supplier and order (name, website, address as read, amount, expiry, document hash) and returns an approval link; `GET /v1/proposals/:id`. Same document, same proposal. Nothing on chain changes until the owner signs (Slice 9 builds the signing page).
- **Both addresses on a mismatch.** When the contract refuses with `PayToNotOnFile`, the check reads the supplier's address on file and stores both in the evidence, so every face (tool text, status page, later the approver app) can show them side by side.
- **A status page.** `GET /p/:id`: a plain, read-only page for a request (status, reason, the two addresses, the transaction). The approval link points here until Slice 9/11's approver app replaces it.

**5. The MCP server** (`services/mcp`, Next.js route on Vercel, the Slice 4 stack). Six tools, each with zod input and output schemas, `structuredContent`, and text written for the agent to relay to the person:

| Tool | Annotations | Returns |
|---|---|---|
| `list_open_orders` | read-only | Open orders: supplier, address on file, left, expiry |
| `check_invoice` | read-only | `would_settle`, `held` or `blocked`, with the reason |
| `pay_invoice` | destructive, idempotent | Settled (with the transaction), held (reason, both addresses, approval link) or blocked; waits up to 10 s, else `settling` with the id |
| `pay_invoices` | destructive, idempotent | A run id and each invoice's status so far |
| `payment_status` | read-only | A request, a run or a proposal by id |
| `propose_order` | not read-only, not destructive, idempotent | The proposal and its approval link; nothing changes until the passkey signs |

The server calls the gateway through the SDK (dogfooding). A held result's text says what changed and gives the link; it never asks the agent to retry around a hold.

**6. Sign-in.** A bearer token on the MCP server for now (Claude Code, Codex, API agents). claude.ai, Grok and ChatGPT need OAuth: Slice 13.

**7. Docs and examples.** `docs/developers/quickstart.md` (install, the three modes, paying a testnet invoice, what a hold looks like, the stated limits), linked from the README; `examples/pay-an-invoice` (the SDK in about 30 lines) and `examples/claude-code` (the MCP config). The API reference is generated (`/docs` on the gateway). The full docs site is Slice 21.

**8. Distribution.** `pnpm --filter @countersign/sdk build && npm pack` produces `countersign-sdk-<version>.tgz`, attached to a GitHub release; `npm i <release URL>` works with npm, pnpm, yarn and bun (D34).

## API (added to the gateway)

| Method | Path | Purpose |
|---|---|---|
| GET | `/openapi.json`, `/docs` | The generated OpenAPI document and its reference page |
| POST | `/v1/checks` | The check with no payment |
| POST | `/v1/accounts` | Register an account for indexing |
| GET | `/v1/accounts/:account/orders` | Open orders |
| POST, GET | `/v1/proposals`, `/v1/proposals/:id` | Propose a supplier and an order; its status |
| GET | `/p/:id` | A read-only status page (the approval link until Slice 9/11) |

## What gets built

```
packages/sdk/                 @countersign/sdk: client, signing, invoice ids, amounts, feed, errors (tsdown)
packages/shared/              invoice-id normalization + test vectors; check verdicts
services/gateway/src/
  app.ts → routes/*.ts        createRoute definitions (OpenAPI) for every route
  chain/indexer.ts (+ test)   orders and suppliers from finalized receipts; resume with getLogs windows
  pipeline/check.ts           both addresses on PayToNotOnFile; a dry-run entry for /v1/checks
  pages/status.ts             the read-only status page
  drizzle/0001_*.sql          accounts, orders, proposals, indexer state
services/mcp/                 Next.js + mcp-handler: the six tools (Vercel)
examples/pay-an-invoice/      the SDK quickstart, runnable against testnet
examples/claude-code/         the MCP config
docs/developers/quickstart.md
```

## Tests first

**Unit:** invoice-id normalization against the shared vectors; `usdc()` and formatting at the edges (0.000001, no floats, too many decimals refused); the SDK's signature recovers to the agent key and its typed data equals the Slice 5 fixture; the SSE parser (split chunks, keep-alives, reconnect); error mapping for every gateway error code; each tool's input validation and output shape; the held text contains the reason, both addresses and the link; the indexer adds an order from a receipt's `OrderApproved` log, closes it on `OrderClosed`, and resumes from its saved block.

**Integration (real Postgres, the fake chain from Slice 6):** the SDK against the real gateway app in-process: pay settles, the same invoice returns the same request, a look-alike is held with both addresses, a run of 5 streams to final; `/v1/checks` stores nothing and sends nothing; proposals are idempotent; `/openapi.json` lists every route and validates as OpenAPI 3.1; each MCP tool through an in-memory MCP client.

**Testnet (manual):** below.

## Git workflow

`feature/slice-12-developer-kit` off `development`; gated commits (`pnpm check`, `forge fmt --check` when contracts change, `gitleaks git --staged`); merged after CI passes. The gateway redeploys on Railway from `development`; the MCP server deploys on Vercel.

## Manual testing (at most 6 payments, about 0.17 MON)

1. `/openapi.json` and `/docs` on the hosted gateway; the reference page lists every route.
2. In an empty folder, `npm i <release URL>` and run `examples/pay-an-invoice` against the hosted gateway: one clean invoice settles.
3. Claude Code with the hosted MCP server: `list_open_orders`; `check_invoice` (nothing paid); `pay_invoice` for a clean invoice (settled, with the transaction); `pay_invoice` with a look-alike address (held, both addresses, the link opens the status page); the same invoice again (the same result, no new transaction); `pay_invoices` for a run of 3; `payment_status`.
4. `propose_order` returns a link and nothing changes on chain.

## Results (7 Oct 2026, Monad testnet)

| Measure | Value |
|---|---|
| SDK quickstart: install to settled | `npm i <release URL>` in an empty folder: 3 s. `examples/pay-an-invoice` against the hosted gateway: one 0.001 USDC invoice settled in 1.9 s (tx `0x0dc68405…54e7`); the status page shows it paid |
| Claude Code through the hosted MCP server | Headless, 8 turns, 56 s, $0.26: listed both orders and chose the one with the most left; paid a clean invoice; held a look-alike with both addresses and the owner's link, and did not retry around it; recognised the resent invoice; paid a run of 3; read the run's status. After the duplicate fix (below): 6 turns, 29 s, $0.19, and it reported exactly one payment |
| `propose_order` / `proposeOrder` | A pending proposal with its approval link; the same quote again is the same proposal; nothing on chain changed |
| Order index | Account registered from block 68,894,518; both testnet orders found from their chain events within a minute (137k blocks in 100-block windows); what is left read live (3,000 and 13,600 base units) |
| Web API reference | `/openapi.json` (OpenAPI 3.1, 13 paths, validated in tests) and `/docs` on the hosted gateway |
| Payments and gas | 6 payments, 0.006 USDC (one order 3,000 → 2,000 base units, the other 13,600 → 8,600); the relayers hold about 0.10 MON (about 3 more payments) |
| Tests | 259 TypeScript tests (SDK unit, the SDK end to end against the gateway, the MCP server through a real MCP client, gateway routes, indexer, OpenAPI) |

### Findings, carried forward

1. **A resent invoice read like a new payment (fixed in `782e03e`).** The tool answered "Paid 0.001 USDC …" for the earlier request, and Claude Code's summary counted five payments where the vault paid four (13,600 to 9,600 base units). `pay()` now returns `duplicate`, and the tool says first that nothing new was paid. → Slice 14 (chat messages), Slice 20 (the benchmark counts payments from the chain, never from the agent's words).
2. **Turbopack cannot map the workspace packages' `.js` specifiers to their `.ts` sources.** The MCP server builds with webpack (`next build --webpack`, `resolve.extensionAlias`). → Slices 9, 11 and 7 (every Next.js app that imports the SDK or `packages/shared`).
3. **Vercel's CLI uploads local files.** An allow-list `.vercelignore` at the repo root (package files, packages, services, spikes; never `.env`), checked against the deployment's own file list. → every Vercel app.
4. **`railway up .` fails ("prefix not found"); `railway up` without the path works.** → Slice 21's deploy notes.
5. **GitHub refused every push for about 20 minutes with a 500** (even an empty commit) while its status page said operational; work continued in local commits and pushed once it recovered.
6. **The feed must stop at once on abort.** Some runtimes do not tie the abort to the response body; the SDK now cancels the reader. → Slice 16 (the run board's feed).
7. **One wording for every reason** (`REASON_TEXT` in `packages/shared`), used by the status page, the SDK and the tools. → Slices 11 and 14.
8. **More MON is needed** before Slice 16 and the demo (the relayers hold about 0.10).
9. **`railway up` drops the service's branch trigger.** After a manual `railway up`, merges to `development` stopped deploying until the source was reconnected to `development`. → Slice 21's deploy notes.

## Commit

Gated commits, merged into `development` after CI passes.

## Next

Slice 19: ERC-8004 agent identity (D33 build order), then Slice 7. Before the demo: another Metropolis team integrates (the quickstart and the release are ready).

## Part 2 (8 Oct): a test account a developer makes alone

**Why.** Another team integrating is 20% of the score, and on 8 Oct a developer still could not get an account without us: the quickstart said "message us", judge mode (Slice 9 part 4) sets accounts up only for our hosted demo agent, and the gateway has one service token, which cannot be handed out. Found while drafting the integration offer.

**What.** One call on the developer's machine gives a working testnet account:

1. `POST /v1/demo/accounts` takes an optional `agent` address. The policy then names the developer's own agent key (not the hosted demo agent), and the account is a separate one for that passkey and agent (salt `keccak256(abi.encode(DEMO_SALT, agent))`), so a judge account for the same passkey is untouched. The demo agent's invoices are refused for it (`409 not_hosted`): its own agent pays.
2. `POST /v1/demo/accounts/{account}/token`: any one owner's passkey signs `keccak256(abi.encode("Countersign: API token", chainId, account, generation))` and gets an **account token** (`cs_` and 32 random bytes), shown once and stored only as its SHA-256. A new token revokes the previous one, and the generation in the challenge means a used signature can't mint another.
3. The gateway accepts the service token as before, or an account token, which is allowed **only its own account's routes**: pay, pay a run, check, the account's orders, its payments, runs and proposals, propose, and the feed filtered to its account (feed events now carry `account`). Every other route refuses it (default deny); another account's payment or proposal answers 404, as if unknown.
4. The SDK gets `createTestAccount()` at `@countersign/sdk/test-account` (Node only: P-256 from `node:crypto`). It makes an owner key and an agent key locally, creates and sets up the account, gets the token, and returns everything for a `.env`; `decide()` pays a hold once or refuses it with the test owner key through the approvals API. A `countersign-test-account` command prints the `.env` block.

**Limits, stated.** The test owner is a key in a file, not a passkey on a phone: test accounts only, on testnet. Test accounts share judge mode's daily limit (10 a day, about 0.09 MON each; raised to 30 by Afshal on 8 Oct, relayers topped up to 1 MON each). The hosted MCP server still pays from the shared demo account; an MCP client on its own account is a later step.

**Tests first.** Creating with an agent (the policy names it, a different account from the judge's, `not_hosted` on demo invoices); the token route (wrong passkey, wrong challenge, rotation revokes, a replayed signature refused); scoping on every route (own account allowed, another account 403 or 404, a gateway-wide route 403, an unknown token 401, the feed filtered); the SDK end to end against the in-process gateway (create, set up, token, pay, hold, decide).

**Results (8 Oct, Monad testnet).** Built test-first (24 new tests; 521 in the repo pass). SDK 0.2.0 released as `sdk-v0.2.0` (14 kB). Run from an empty folder with the published tarball, as an outside developer would:

| Step | Result |
|---|---|
| `npm run account` (`countersign-test-account`) | Account `0xb786EA615545D92994Fc088990CD052b608F096c` made, set up and its order indexed in 16 s; `.env` written |
| `npm start`: Kalibre Studio's clean invoice, read from the supplier's page | Settled in 2.5 s, checker included ([transaction](https://testnet.monadexplorer.com/tx/0xb597fb9d12e067bdac6bbd3021cafa9ea2e73cf894d178a1911672c69826bbb8)) |
| The changed-address invoice (`ks-1002`) | Held, `address_mismatch`; refused with `decide()` and the test owner key |
| The account token on the main demo account | `403 wrong_account` |
| The account token on a gateway-wide route (`/v1/agents`) | `403 not_for_account_tokens` |

**Found on the way:** the old example paid with no invoice to read, which the real checker (Slice 10) holds; the example now reads the supplier's own page and passes it, as an agent would. A plain `cp` of this file over the workspace copy dropped the workspace's footer; restored.

## Decisions (made 7 Oct)

| # | Decision | Decided |
|---|---|---|
| S12-1 | SDK | `@countersign/sdk`, tsdown to ESM + types, viem its one runtime dependency, fetch only; shipped as a GitHub release tarball (D34) |
| S12-2 | Modes | SDK mode (the agent's key signs locally) and hosted mode (the MCP server holds the key; one demo account until Slice 13) |
| S12-3 | Invoice identity | keccak256 of (supplierId, normalized invoice number); shared test vectors |
| S12-4 | Amounts | Decimal strings or bigints at every boundary, base units on the wire, never floats |
| S12-5 | Web API docs | `@hono/zod-openapi` + Scalar at `/docs`, generated from the validation schemas |
| S12-6 | Open orders | Indexed from finalized receipts the tracker already reads; resumed with endpoint-sized `eth_getLogs` windows |
| S12-7 | Approval link | A read-only status page on the gateway until the approver app (Slices 9 and 11) |
| S12-8 | Pay-tool prompts | No `requiresUserInteraction` on pay tools (changes Slice 4's plan): the contract is the boundary (D32); `destructiveHint` and `idempotentHint` set |
| S12-9 | MCP sign-in | Bearer token now; OAuth in Slice 13 |
| S12-10 | A developer's own test account (8 Oct) | Judge mode with an `agent` address: one account per passkey and agent, the developer's key named in the policy |
| S12-11 | Account tokens (8 Oct) | `cs_` + 32 random bytes, stored as SHA-256, one live per account, issued by an owner's passkey over a challenge with a generation; allowed only the account's own routes (default deny) |
| S12-12 | Test accounts in the SDK (8 Oct) | `@countersign/sdk/test-account`, Node only (`node:crypto` P-256, no new dependency), plus a `countersign-test-account` command |
