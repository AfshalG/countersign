# Slice 4 (Spike): one Countersign connector, reached from Grok, Claude, Codex, ChatGPT and Muse

## Status

**DECIDED (7 Oct 2026); ready to build.** Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices); Muse's directory and the accounts are Afshal's. Owner: Roshan (MCP server, D6); Claude builds while he is busy.

## Goal

Prove that **one** Countersign MCP server, on public HTTPS, can be added to each agent people use, and that each agent can find its tools, call them, and show a held result to the person. Record, per agent, how it connects, how it signs in, which plan it needs, and whether it can pause and ask the person (elicitation). Build the OpenRouter test agent that runs the same scenario on several AI models.

**What this spike decides**

| If an agent connects | If it can't |
|---|---|
| The demo (Slice 14) runs in it; we record its plan, sign-in and pause-and-ask support | It is listed with the reason; the demo runs in those that can, with Claude as the floor (D11, D30) |

## Prerequisites

- Slices 0 to 2 done. ✅
- **Accounts:** Grok (grok.com; the plan for custom connectors is unclear: xAI says all users, others say paid), Claude (Pro or above for Claude Code; claude.ai allows one custom connector on Free), Codex (Plus or above, or an API key), ChatGPT developer mode (Business, Enterprise or Edu for full use; Pro may be read-only), Muse (free, US). Afshal's accounts, or a teammate's; each result notes the plan used.
- **Vercel** for hosting: the CLI is already logged in to Afshal's account (`afshalgs-projects`).
- An OpenRouter API key in `.env` (`OPENROUTER_API_KEY`, already listed for the checker), and an xAI API key if the Grok API path is tested (`XAI_API_KEY`).

## Cross-checked (7 Oct 2026)

| Topic | Fact | Source |
|---|---|---|
| MCP standard | Revision **2026-07-28** shipped: stateless requests (no session id, no `initialize`), elicitation replaced by multi-round-trip requests (`input_required`), DCR deprecated in favour of Client ID Metadata Documents (CIMD), SSE deprecated | modelcontextprotocol.io/specification/2026-07-28/changelog |
| TypeScript SDK | v2: `@modelcontextprotocol/server` 2.3.1 (+ `client`, `node`, `express`, `hono`); needs Node 20+ and zod 4. v1 `@modelcontextprotocol/sdk` 1.32.1 still published (protocol 2025-11-25). Context7: v2 at `/websites/ts_sdk_modelcontextprotocol_io_v2` | npm, ts.sdk.modelcontextprotocol.io/v2 |
| Server shape (v2) | `McpServer` + `registerTool(name, {title, description, inputSchema, annotations}, handler)`; `createMcpHandler` is stateless; a sessionful `NodeStreamableHTTPServerTransport({ sessionIdGenerator })` serves 2025-era clients, routed with `isLegacyRequest` | v2 docs, `examples/legacy-routing` |
| Elicitation | Form: `ctx.mcpReq.elicitInput({mode:'form', …})`; URL: `{mode:'url', url, elicitationId}`. Reaches 2025-era clients **only over a sessionful connection**, not stateless HTTP | v2 elicitation and migration docs |
| Auth (v2) | `requireBearerAuth({ verifier, … })` (the verifier must throw `OAuthError(InvalidToken)`, anything else is a 500); `mcpAuthMetadataRouter` for protected-resource metadata; a full authorization server only in `server-legacy`, otherwise external | v2 authorization docs |
| Hosting | Vercel `mcp-handler` 2.2.0 (peer `@modelcontextprotocol/server` ^2, Next.js 13+) is stateless: it serves 2026-07-28 natively and 2025-era clients statelessly, so 2025-era pause-and-ask is lost; 300 s per call on Hobby; `withMcpAuth` for OAuth later. Railway runs persistent containers; HTTP streams up to 15 min with heartbeats | vercel.com/docs/mcp, npm, docs.railway.com |
| Vercel AI SDK | `ai` 7.0.129; `@ai-sdk/mcp` 2.0.68: `createMCPClient({ transport: { type: 'http', url, headers, authProvider } })`, `client.tools()` gives AI SDK tools, `onElicitationRequest` handles pause-and-ask; `@openrouter/ai-sdk-provider` 3.1.0 plugs OpenRouter models into `generateText` | Context7 `/websites/ai-sdk_dev`, `/openrouterteam/ai-sdk-provider`, npm |
| Grok (grok.com) | grok.com/connectors → New Connector → Custom → URL → sign in. OAuth via CIMD (`grok.com/oauth/mcp-client.json`); must be public (no localhost or private IPs). Plan: unclear. Elicitation: not documented | docs.x.ai/grok/connectors |
| Grok (API, CLI) | xAI Responses API: `{"type":"mcp","server_url",…}` in `tools`, Streamable HTTP or SSE, `authorization` header. Grok CLI: `grok mcp add --transport http <name> <url> --header …` | docs.x.ai/developers/tools/remote-mcp, docs.x.ai/build/features/mcp-servers |
| Grok Bot | A separate xAI product (cloud computer); connectors from its Marketplace; custom MCP only via third-party reports | docs.x.ai/grok-bot |
| claude.ai | Customize → Connectors → Add custom connector → URL → sign-in mode (OAuth DCR/CIMD, or none; static headers beta-only). Streamable HTTP. Elicitation: not documented (one report says not shown). `readOnlyHint` tools run without confirmation; destructive ones always prompt. Tool calls time out at 240 s | support.claude.com, claude.com/docs/connectors |
| Claude Code | `claude mcp add --transport http <name> <url> [--header "Authorization: Bearer $T"]`; OAuth via `/mcp`. **Elicitation: form and URL modes.** `_meta["anthropic/requiresUserInteraction"]` forces a prompt on every call. Needs Pro or above | code.claude.com/docs/en/mcp |
| Codex CLI | `codex mcp add <name> --url … [--bearer-token-env-var VAR]`; OAuth via `codex mcp login`. Streamable HTTP. Elicitation form and URL (source, on by default). **Tool timeout 60 s by default.** Plus or above, or API key | learn.chatgpt.com/docs/extend/mcp |
| ChatGPT | Developer mode → plugins → Add custom MCP server (web only). OAuth (static, CIMD or DCR) or no auth; **no bearer token**. Plan eligibility unclear | developers.openai.com/api/docs/guides/custom-mcp-server |
| Muse | Free, US; iOS, Android, muse.ai and **inside WhatsApp**. Custom connectors are built in chat from "APIs or CLIs"; official docs never mention an MCP URL. A reviewed directory (muse.ai/platform) takes MCP servers after business verification and QA. Writes need approval in the app | about.fb.com, meta.com/help, muse.ai/platform/docs |
| Instinct | Text or call; its app opens iMessage (`sms:`) and WhatsApp (`wa.me`). No developer, API, MCP or plugin surface found | instinct.com, app bundle, Fortune |
| OpenRouter | OpenAI-style `tools` on every request; 376 of 466 models support tools (OpenAI, Anthropic, xAI, Google, Llama, Qwen, Mistral, DeepSeek). **Not an MCP client:** bridge ourselves (hand-rolled, or `@openrouter/mcp`) | openrouter.ai/docs |
| WhatsApp | Link buttons via `cta_url` messages; free-form only within 24 h of the user's last message, otherwise an approved template (review up to 24 h). A test number works without business verification. Service messages charged since 1 Oct 2026 beyond 1,000 free a month. iMessage needs an Apple-approved provider | developers.facebook.com/docs/whatsapp, register.apple.com |

## Checked against earlier slices

| Slice | What it changes here |
|---|---|
| 0 | Node 24, pnpm 12, TypeScript 6.0.3; settings through the fail-closed loader (`OPENROUTER_API_KEY` and any server token); one CI job per spike; gated commits |
| 1 | A Vercel project served the phone test page over HTTPS with secrets as encrypted settings; the same account and pattern host this server. Link files (`.vercel/`) are never committed; after the 6 Oct revert a lost link created a stray project, so `vercel link --project <name>` is run explicitly before every deploy |
| 2 | Scripts and long-running clients exit explicitly with a time limit (Primus's SDK hung without it; MCP clients can too) |
| Architecture | The six MCP tools (Slice 12) and their idempotency; "In the agent chat" pause-and-ask with a link to the approval page; D19 (ways in), D30 (one connector, many agents), D31 (WhatsApp is a separate channel, not tested here); D27 (the model can only hold) does not apply to the agent itself, which is untrusted |

## Design considerations

**1. A minimal test server, not the product.** Two tools are enough to prove the connection:
- `check_payment(supplier, amount, payTo)`: returns `settled` or `held` with a reason, from fixed demo rules (an address on a list is settled; any other is held as `address_mismatch`). No chain calls.
- `connection_info()`: returns which client called and when, so each agent's call is visible in the server log.

The real six tools come in Slice 12.

**2. One server, both protocol versions, on Vercel.** `mcp-handler` (built on MCP SDK v2) as a Next.js route. New-protocol clients (Claude Code negotiates 2026-07-28) get pause-and-ask through the new multi-round-trip input, which needs no held connection. 2025-era clients are served statelessly, so Codex loses pause-and-ask; acceptable, because consent never depends on it (point 4). *Alternative:* a sessionful server on Railway, rejected: its only gain is pause-and-ask in Codex, against a second platform, no `withMcpAuth`, and none of Vercel's integrations. Railway stays for the always-running gateway (Slice 6).

**3. Sign-in for the spike.** Two doors on the same tools:
- **No sign-in** for the web apps (grok.com, claude.ai, ChatGPT): the test tools return demo answers only, touch no money and hold no data, so an open door is acceptable for a spike, with a request-rate limit.
- **A bearer token** (`CONNECTOR_TEST_TOKEN` in `.env`) for Claude Code, Codex, the xAI API, the Grok CLI and the OpenRouter agent, to prove the token path.

Real sign-in (OAuth with CIMD, falling back to DCR, which every OAuth client here accepts) is Slice 13; the v2 SDK needs an external authorization server or `server-legacy`'s, decided there.

**4. Consent never depends on pause-and-ask.** Only Claude Code and Codex support elicitation today, and on Vercel only Claude Code (new protocol) gets it. So every held result carries the approval link in its text, and (from Slice 14) goes to WhatsApp; where pause-and-ask works, the agent also asks "Approve or refuse?" with the same link. Tools never wait on a person: Codex cuts tools off at 60 s and claude.ai at 240 s. The agent checks back with a status tool.

**4b. Tool hints.** `check_payment` is marked `readOnlyHint` (runs without a confirmation prompt in claude.ai and ChatGPT). Future pay tools will be `destructiveHint`, and in Claude Code `requiresUserInteraction`, so the agent app itself also asks.

**5. The OpenRouter test agent, on the Vercel AI SDK.** OpenRouter is not an MCP client, so the AI SDK bridges: `createMCPClient` connects to our server and `client.tools()` turns its tools into AI SDK tools; `generateText` runs each model through the OpenRouter provider on the same task ("pay these three invoices"; one has a changed address), with a step limit; the run records which tools each model called and what it told the user. *Alternatives:* a hand-rolled bridge (more code of ours to maintain) or `@openrouter/mcp` (smaller ecosystem); the AI SDK is the most used and also serves the checker's Claude fallback later. Models, one per family, exact slugs read from OpenRouter's live list at build time: OpenAI GPT, Anthropic Claude, xAI Grok, Google Gemini, Meta Llama, Qwen. Reused by the benchmark (Slice 20).

**6. Muse.** Two paths. In chat: ask Muse to build a custom connector for our server (its docs cover APIs and CLIs, not MCP URLs, so this tests whether it manages anyway). The reviewed directory (muse.ai/platform) takes MCP servers but needs business verification, a questionnaire and QA, with a waitlist: a decision for Afshal, not a dependency.

**7. Instinct.** Confirmed: no tool surface (text, call, iMessage, WhatsApp). Countersign meets its users through WhatsApp approval requests (D31, Slice 14). Muse also runs inside WhatsApp.

**8. WhatsApp constraints for Slice 14 (recorded now, built then).** Link buttons work (`cta_url`), but free-form messages only within 24 hours of the person's last message, so the person messages Countersign once to connect; outside the window an approved template with a URL button is needed, and review takes up to a day, so it is submitted early. A test number works without business verification.

**9. Spike code lives in `spikes/04-connectors/`** and is never imported by product code.

## What gets built

```
spikes/04-connectors/
├── README.md                 per-agent results table, how to connect each one
├── server/                   Next.js app on Vercel
│   ├── app/api/mcp/route.ts  mcp-handler (MCP SDK v2): both protocol versions, two doors
│   ├── lib/tools.ts (+ test) check_payment, connection_info
│   └── lib/auth.ts (+ test)  bearer token for the token door; rate limit for the open door
├── agent/openrouter.ts       the test agent: AI SDK createMCPClient + generateText per model
└── agent/report.ts (+ test)  turns its runs into a per-model table
```

## Tests first

**Vitest**
1. `check_payment`: an address on the list is `settled`; a look-alike is `held` with `address_mismatch` and an approval link.
2. Inputs that are not a valid supplier, amount or address are refused with a clear error, never a guess.
3. Auth: on the token door, a missing or wrong token is refused with a 401 and an MCP auth challenge (the verifier throws `OAuthError(InvalidToken)`, never a 500); on the open door, a burst over the rate limit is refused with 429.
4. Protocol: a 2026-07-28 request and a 2025-era request both list and call the tools.
5. The test agent's wiring: against an in-process test server, `createMCPClient` lists both tools and a scripted model's tool call reaches `check_payment` with the same arguments.
6. The report: per-model results computed correctly from sample runs.

## Git workflow

```bash
git checkout development && git pull
git checkout -b feature/spike-04-connectors
# commits gated on pnpm check and gitleaks git; merged only after CI passes
```

## Manual testing (the actual spike)

For each of grok.com, the Grok CLI or API, claude.ai, Claude Code, Codex, ChatGPT developer mode (if the plan allows) and Muse:
1. Add the server (steps in the Cross-checked table).
2. Ask: "Check whether I should pay Kalibre Studio 4,200 USDC to 0x90f9…5fEc." Expected: the tool is called; the answer says settled.
3. Ask the same with a look-alike address. Expected: held, with the reason and the approval link; where supported, a pause-and-ask prompt.
4. Record: plan needed, sign-in method, pause-and-ask, time to answer.

Then run the OpenRouter test agent across the chosen models and record what each did.

## Results (filled in after the spike)

| Agent | Connects | Plan needed | Sign-in | Pause and ask | Notes |
|---|---|---|---|---|---|
| grok.com | | | | | |
| Grok CLI / xAI API | | | | | |
| claude.ai | | | | | |
| Claude Code | | | | | |
| Codex | | | | | |
| ChatGPT developer mode | | | | | |
| Muse (custom connector in chat) | | | | | |
| Instinct | Not connectable as a tool | | | | Reached through WhatsApp (D31) |

## Commit

The commits above, merged into `development` with `--no-ff` once CI passes.

## Next

Slice 5: the account and order vaults, using what Spikes 1 to 3 measured.

## Decisions (made 7 Oct)

| # | Decision | Decided |
|---|---|---|
| S4-1 | Hosting | **Vercel** (`mcp-handler`): stateless is enough because consent uses the link; only Codex loses pause-and-ask. Railway only for the gateway |
| S4-2 | SDK | MCP SDK v2 through `mcp-handler`, serving both protocol versions; the **Vercel AI SDK** for the test agent |
| S4-3 | Sign-in for the spike | No sign-in for the web apps (demo tools only), a bearer token for the command-line tools; OAuth in Slice 13 |
| S4-4 | Consent | Always the approval link (and WhatsApp from Slice 14); pause-and-ask only as a bonus where supported |
| S4-5 | OpenRouter models | One per family: GPT, Claude, Grok, Gemini, Llama, Qwen |
| S4-6 | Muse's directory | **Afshal's call** (it needs business verification under his name): not applied for now; the spike uses Muse's in-chat connector |
| S4-7 | Whose accounts | **Afshal's** (or a teammate's); each result records the plan used |

---

