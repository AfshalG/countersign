
# Countersign: a second signature on payments AI agents prepare

## What This Is

An AI agent reads a supplier invoice and drafts the payment. Countersign's checker compares the invoice with the purchase order the company approved. A match is paid from that order's vault on Monad and is final about 0.6 seconds later. Anything that differs (a changed address, a padded amount, a duplicate, a hijacked agent) is held, and a person decides with Face ID. The rule lives in the contract, so it holds whichever agent prepared the payment.

**An open primitive (D33, Track 04).** Developers build on it: an agent builder gives its agent a Countersign account through the SDK or the MCP connector instead of a card or a wallet key; a wallet can offer an agent mode; anyone can run a checker, because the owner sets the checker key. The invoice flow (supplier portal, approver app) is the reference app built on it. Developer experience is judged: every public interface gets docs and an example.

**Two layers (D32).** The contract is the security boundary: paying the wrong party is impossible, whoever signs (proved on testnet in Slice 5, no model involved). The checker is a detector for the right supplier billed the wrong amount (padded, duplicate, wrong order), published with its catch rate and false-hold rate. Lead with the contract; never present the checker as a guarantee.

**Pitch line:** "Your agent can prepare the payment. It should not be the only one who signs it."
**Tagline:** "Check any payment. Enforce it on Monad."

- **Event:** Monad Metropolis 2026, Track 04 (Trust, Identity & AI Infrastructure). Deadline 13 Oct 2026, 20:59 PDT.
- **Users:** B2B, sold self-serve. First users are small teams that use an agent and pay overseas contractors and suppliers.
- **What they need, in order:** speed, no mistakes, ease of use. A change should help at least one and hurt none.

## The Plan Is the Source of Truth

- `docs/plan/00-architecture.md`: pieces, decision model, payment state, keys, contract and MCP surfaces, slice list, decisions D1–D29.
- `docs/plan/slice-NN-*.md`: one file per slice. Read the current slice file before writing its code.
- One slice at a time. A slice file is written and reviewed before its code.
- **Check every new slice file against all earlier slice files**: their findings, adaptations and deployed addresses. Name in its "Checked against earlier slices" section each one that changes this slice.
- **Carry findings forward**: when a slice is built, check every later slice file and the architecture, and update whatever its findings change, in the same commit.
- If the code has to differ from the slice file, record it under "Adapted from spec" in the same commit.

## Layout

```
countersign/
├── CLAUDE.md, README.md, .env.example
├── contracts/           Foundry: Account, OrderVault, factory; unit and fuzz tests
├── services/
│   ├── gateway/         Hono: payment requests, states, relayer pool, finality stream
│   ├── checker/         Hono: reads invoices, compares, asks Jev, signs releases. Own key
│   └── mcp/             MCP server: five tools, sign-in
├── apps/
│   ├── approver/        Next.js PWA: proposals, holds, live feed, the diff
│   └── supplier-portal/ Next.js demo supplier: quotes, invoices, payment arriving
├── packages/
│   ├── shared/          Payment state, reason codes, EIP-712 types, zod schemas
│   ├── chain/           viem clients, ABIs, Monad config
│   ├── sdk/             TypeScript SDK for developers (Slice 12, D33)
│   └── db/              Drizzle schema and migrations
├── bench/               The invoice set and the four benchmark arms
├── spikes/              Throwaway code from Slices 1–4. Never imported by product code
└── docs/plan/           Architecture and slice files
```

## Stack (record every change here with its reason; product scope and spending stay Afshal's call)

| Area | Choice |
|---|---|
| Language | TypeScript, strict mode, everywhere except contracts |
| Monorepo | pnpm workspaces |
| Contracts | Solidity with Foundry; OpenZeppelin Contracts 5.x (`WebAuthn`, `P256`, `EIP712`, `Clones`) |
| Chain client | viem |
| Services | Hono on Node |
| Agent door | MCP SDK v2 (`@modelcontextprotocol/server`) through Vercel's `mcp-handler`; serves the 2026-07-28 protocol and 2025-era clients |
| Model calls and test agent | Vercel AI SDK (`ai`, `@ai-sdk/mcp`, `@openrouter/ai-sdk-provider`) |
| Apps | Next.js; the approver app installs as a PWA |
| Data | Postgres with Drizzle |
| Validation | zod at every boundary |
| Guard model | Jev 1.13 through OpenRouter's System One API: `@typesafe-ai/sdk` with base URL `https://openrouter.ai/api`, model `jev-1.13`, never the moving `jev-latest`. One OpenRouter key covers Jev, the fallback and the test agent; TypeSafe's own API is a drop-in second route. Fallback: Claude Sonnet behind the same interface |
| Attestation | Primus zkTLS |
| Tests | `forge test` (with fuzzing), Vitest, Playwright |
| Hosting | Vercel (apps, MCP server); Railway (gateway, checker and Postgres: always-running processes) |

Pinned in Slice 0 (6 Oct 2026, checked with Context7 and npm): Node 24 LTS, pnpm 12.9.1, TypeScript 6.0.3 (not 7: typescript-eslint supports `<6.1`), Vitest 5.0.3, ESLint 10.12.0 with typescript-eslint 8.71.1, Prettier 3.9.9, zod 4.6.5, Foundry 1.8.5, solc 0.8.37 (`via_ir` on), OpenZeppelin 5.7.0 and forge-std 1.17.0 through Soldeer.

## Commands

- `pnpm install`
- `pnpm check` (typecheck, lint, format check, tests), or each: `pnpm typecheck`, `pnpm lint`, `pnpm test`
- `pnpm test:contracts`, or `forge test` inside `contracts/`
- Settings: `loadEnv(schema)` from `@countersign/shared`. Never read `process.env` directly
- Prefer running one test file while working; run everything before a commit.

## Money Rules (never break these)

1. **Fail closed.** Any error, timeout or "unsure" from the checker is a hold. No code path pays without the checker's signature or the owner's passkey.
2. **The pay-to address comes from the supplier record on chain.** Never from the invoice, the agent's input or a model's output.
3. **Addresses and amounts are compared by code.** A model only answers the checker's fixed yes-or-no questions.
4. **Final means Finalized.** `latest` on Monad is speculative. Show proposed, voted, finalized; release nothing before finalized.
5. **One final status per request,** including after a crash or a cancel. Pay tools are idempotent: same order and invoice, same request id, same result.
6. **Typed outcomes only.** `status`, `reason` and `decidedBy` are defined in `packages/shared`. Change them there first.
7. **A person's refusal ends the agent's run.**
8. **Setup is never automatic.** The agent proposes suppliers and orders; only the owner passkey makes them real.

## Monad Rules

- **Network:** testnet, chain ID 10143. Mainnet (143) only after an explicit decision (D5).
- **USDC:** testnet `0x534b2f3A21130d7a60830c2Df862319e593943A3`, mainnet `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`.
- **Passkeys:** the P256 precompile is at `0x0100` (EIP-7951).
- **Parallel execution:** one vault per order. Payments must not write shared storage (no shared counters or registries); emit events instead.
- **Fees are charged on the gas limit.** Set tight limits and simulate every payment before sending. A failed transaction still pays its fee.
- **Relayers:** a pool of wallets. Track nonces ourselves; "submitted" is unconfirmed until a block contains it. Keep each wallet above the 10 MON reserve. Never give a relayer EIP-7702 delegation.
- **Live stages:** `monadNewHeads` and `monadLogs` websocket subscriptions.
- Chain behaviour comes from docs.monad.xyz, not memory.

## Contract Rules

- The owner is a passkey, verified through the precompile. Every signed payment is EIP-712 typed data.
- Vaults are `Clones` (EIP-1167) with immutable arguments (account, supplier, order hash, expiry, amount): no initialiser, so nothing can be set after creation. Accounts are clones initialised by the factory in the same transaction (OpenZeppelin warns that a clone left uninitialised can be initialised by someone else).
- Every revert is a named error with a test. Every external function has a fuzz test.
- Never pass a caller-supplied digest to `P256.verify`. With a zero hash, a signature for any key can be forged; always let `WebAuthn.verify` hash the signed data itself.

## Checker and Model Rules

- Cap Jev's **total** time at about 1,500 ms with an `AbortSignal`. The SDK's `timeout` is per attempt (default 10,000 ms), it retries twice by default and honours Retry-After for up to 60 s: allow at most one retry and ignore Retry-After. Log the model version each answer reports.
- Tests run against deterministic mock model responses first. Real model calls only after those pass.
- The model never sees a key, and its output never chooses an address or an amount.
- The checker key lives only in the checker service.
- Read invoice fields from structured data first; read a PDF from its text layer and its rendered page, and hold on any disagreement.
- The checker is scored on the invoice set (catch rate, false holds) from Slice 10. Fooling the model can at most let through a payment that already passed every code check and contract rule; say exactly that, never "gains nothing".

## Agent-Facing Features

Before writing code for any agent-facing flow, its slice file has a mermaid diagram (nodes, edges, decision points) and an explicit state schema. The payment request's diagram and state are in `docs/plan/00-architecture.md`.

## Secrets and Private Material

- Every secret and setting comes from environment variables. `.env.example` lists names only. Never commit `.env`.
- No key, token or private key in code, tests, docs, commit messages or this file.
- CI runs a secret scan on every push.
- Nothing from the private research workspace enters this repo. Plan files are checked before they are copied in.

## Workflow

- **Context7 before any library API.** Do not guess signatures. Record what was checked in the slice file's "Cross-checked" section.
- **TDD:** failing test, then code, then refactor. Run tests after every significant change. Never commit broken code.
- **Git:** never commit to `main`. Branch from `development` as `feature/…`, `fix/…` or `chore/…`. Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`). Merge into `development` when the slice is done and tested, then delete the branch. `development` goes to `main` only at a stable milestone.
- **Pushes:** push to `development` and feature branches only, never to `main`. No AI co-author or attribution lines in commits or PRs.
- **Error handling everywhere.** No happy-path-only code. Comment the non-obvious decisions.

## Who Owns What (D6)

- **Afshal:** contracts, gateway
- **Roshan:** checker, MCP server
- **Sophie:** approver app, supplier portal

## Design Guidelines

- Mobile-first; works on a laptop.
- **The approval sheet's centrepiece is the difference:** the address on file against the one on the invoice, character by character; the added line; the amount over tolerance.
- Matched payments ask nothing. Show people only what needs them.
- Never mention gas, MON or seed phrases in the interface.
- Use the frontend-design skill for app work. Sophie sets the visual direction in Slice 11.
- No `window.alert`, `confirm` or `prompt`; use in-page sheets and toasts.

## Stated Limits (say them, don't hide them)

- In hosted mode we hold both the agent key and the checker key, in separate services. The contract's limits bound that case.
- The checker reads the same invoice the agent read.
- Enforcement needs the supplier to accept USDC; otherwise the check is advice only.
- A proposal is only as good as the person who approves it.
- Payees and amounts are public on chain; documents stay off chain as hashes.
