# Slice 14: Proposals and holds in the chat, and on WhatsApp

## Status

**IN PROGRESS (8 Oct 2026).** Built and tested: the question in the chat (live on the hosted MCP server), WhatsApp's sender and webhook (against a fake Cloud API), and the real-agent runner (first live run: NVIDIA Nemotron 3 Super, 6 of 6). Waiting on Afshal: signing in at developers.facebook.com once for WhatsApp's test number (signing up is his), and a yes before any Claude run (cost). Technical decisions made by Claude (Afshal, 7 Oct: decide technical choices). His accounts and money are his to decide: WhatsApp (a Meta developer account), running real agents in his Claude, OpenRouter credits.

## Goal

When an agent's payment is held, or it proposes a new supplier, the person hears about it where they already are, and decides with their passkey on the approval page:

1. **In the agent's chat**, always as a link in the tool's answer (works today), and where the client can, as a question the agent app shows: "A payment is held: approve or refuse here". Then the agent checks back and tells the person what happened.
2. **On WhatsApp** (D31): a message from Countersign with a button that opens the approval page, whichever agent prepared the payment.
3. **In real agents**, the demo documents (Slice 7) paid by the agents people use (Claude, Grok, the OpenRouter models), recorded as before-and-after stories (the pitch).

## Checked before writing this (7 Oct)

- **MCP SDK v2 (2.3.1, installed), Context7 `/websites/ts_sdk_modelcontextprotocol_io_v2`:** on protocol 2026-07-28 a stateless server asks the person mid-call by returning `inputRequired({ inputRequests: { approve: inputRequired.elicitUrl({ message, url }) } })`; the client shows it, then re-sends the call with `ctx.mcpReq.inputResponses` (and `requestState`, which is attacker-controlled on re-entry). A request the client did not declare in its per-request capabilities (`ctx.mcpReq.envelope`, key `CLIENT_CAPABILITIES_META_KEY`) fails the whole call (`-32021`), so the server asks only clients that declared URL elicitation. 2025-era connections have no such vocabulary: they get the link in the text, as today.
- **Spike 4:** Claude Code negotiates 2026-07-28 and is the one client expected to show the question; claude.ai, Grok and ChatGPT show the link. Tools never wait on a person (Codex cuts tools at 60 s, claude.ai at 240 s).
- **WhatsApp Business Cloud API** (D31, checked 6 Oct): a link-button message (`interactive` type `cta_url`); free-form messages only within 24 hours of the person's last message, so the person messages Countersign once to connect; outside that window an approved template with a URL button (review up to 24 h); a test number works without business verification.

## Checked against earlier slices and decisions

| Source | What carries into Slice 14 |
|---|---|
| S4-4 | Consent never depends on the question: every held result keeps its link; the question is a bonus where supported |
| Slice 9 (and D36) | The approval page and the passkey decide; "1 of 2 signed" when an account needs two; refusing ends the agent's run |
| Slice 10 | The checker's reason and evidence are what the person sees first |
| Slice 12 | The six tools; `payment_status` is how the agent checks back |
| Slice 13 | claude.ai, Grok and ChatGPT reach the server signed in |
| Slice 19 | A2A agents get `auth-required` with the same link |
| D31 | WhatsApp: opt-in by the person's first message, then a template outside 24 hours; iMessage not offered |
| Story-led demos (Afshal) | Real agents, before and after, never a faked agent |

## Design

1. **The question in the chat (MCP).** When `pay_invoice` or `pay_invoices` returns held, or `propose_order` returns pending, and the request declared URL elicitation, the tool answers `input_required` with the approval link ("Held: the address is not the one on file. Approve or refuse with your passkey"). When the client re-sends the call (the person opened the page, decided or not), the tool reads the payment's status again and answers with it: settled after a pay once, refused, or still held with the link. Idempotent as before: the same invoice is the same request, so the re-sent call never pays twice. `requestState` is not trusted: the tool re-reads the status from the gateway.
2. **WhatsApp (D31).** A small sender in the gateway: the person connects by messaging Countersign's number (a webhook records their number against their account, with consent); a held payment or a proposal then sends a link-button message to the approval page (a template outside 24 hours). The phone number, its token and the webhook's verify token are settings; nothing is sent without them.
3. **Real agents.** claude.ai (signed in) and Claude Code (token) pay the demo documents for the main account and judge accounts; the OpenRouter test agent (Spike 4's, on the AI SDK) runs the same documents across model families. Each run is recorded: what the agent read, what it paid, what was held, what it told the person.

## Tests first

The tool's question: asked only when URL elicitation is declared; the re-sent call reports the new status; a 2025-era call answers with the link and no question; a forged `requestState` changes nothing. WhatsApp: the webhook's verification and signature check; a held payment sends one message per connected person; nothing without settings; the 24-hour rule picks a template.

## Manual testing

Claude Code against the hosted MCP server: a changed-address invoice shows the question, the person refuses on the page, Claude Code reports "refused". WhatsApp: a held payment reaches Afshal's phone and the button opens the approval page.

## Built (8 Oct)

**The question in the chat** (`services/mcp/lib/tools.ts`). `pay_invoice` held, or `propose_order` pending, on a request whose client declared URL elicitation, answers `input_required` with `elicitUrl` (the approval link, and the reason in plain words). The re-sent call (`inputResponses.decide` present) pays the same invoice again, which is the same request, so nothing new is paid, and answers with the gateway's status: refused, paid once, or still held with the link. A proposal's re-sent call reads the proposal's status. Clients that did not declare it get the link in the answer, as before. A forged answer on a first call gets exactly what any call gets.

- One change from the design: `pay_invoices` does not ask. It returns a run id before any invoice is checked, so there is nothing to ask about yet; holds in a run reach the person on WhatsApp and through `payment_status`.
- Tests: 5 with the official MCP client 2.3.1 on 2026-07-28 (a URL-capable client asked, then told "refused" after the page; still held when undecided; a client without URL elicitation gets only the link; a proposal asked, then "approved"; a forged answer changes nothing).
- Live (`pnpm --filter @countersign/mcp-server question-smoke`, hosted server, 8 Oct 00:28 PDT): a changed-address invoice asked in 946 ms with the approval link, and the re-sent call reported it still held; a client without URL elicitation got the link in the answer. No model, nothing paid.

**WhatsApp** (`services/gateway/src/notify/`, `src/api/whatsapp.ts`, migration `0006_whatsapp`). Built against a fake Cloud API in Meta's documented shapes (Graph API v25.0, checked 8 Oct).

- Connecting: the owner asks for a code (`POST /v1/whatsapp/codes`), signs its challenge with their passkey (`POST /v1/whatsapp/codes/{code}`; any one owner, always checked), and sends `CONNECT <code>` from WhatsApp (the response includes a wa.me link with the text typed). A code lasts 15 minutes, works once, and does nothing until an owner signs it; an account gets at most 10 codes an hour. The person's message is their consent and opens the 24-hour window. STOP disconnects.
- Sending: a held payment or a new proposal sends each connected person one message with a "Review and decide" button to `/p/<id>`: a link-button message inside 24 hours of their last message, the `countersign_decision` utility template outside it (skipped and recorded without one). One message per decision and person (claimed in the database before sending); at most 10 an hour to one number, so a 200-invoice run cannot flood a phone; a refused send is recorded and never reaches the payment path. Delivery statuses from the webhook move forward only.
- The webhook answers Meta's verification only for our verify token and acts only on bodies Meta signed (HMAC-SHA256 of the raw body with the app secret, constant-time comparison).
- Off unless all five settings are set (phone number id, access token, app secret, verify token, number); half-configured refuses to start. `/health` shows whether it is on.
- Tests: 25 (connecting, wrong passkey, unsigned/used/expired codes, the code cap, STOP, one message per person, the template outside 24 hours, a message reopening the window, the hourly cap, a refused send, delivery statuses, proposals, the webhook's signature and verification, the routes without a token, the settings).
- Scripts: `whatsapp-template` creates the template in the WhatsApp Business account; `whatsapp-connect` connects a phone to the hosted demo account with its passkey (Slice 5's software key).
- Known gap: a hold during a gateway restart, between storing it and sending, is not messaged (the agent's link still reaches the person). Slice 16 or 22 can add a sweep at start.

**Real agents** (`apps/agent-runner`). A model on OpenRouter gets the hosted MCP server's tools and a page reader (hidden text included, as agents' readers return it) and is asked to pay six supplier invoices at their links (`?run=` gives each run its own invoice numbers). The run records the tool calls, Countersign's answers and what the model told the person, and scores each invoice: clean paid, doctored not paid; a run that failed scores `run_failed`, never as invoices safely left unpaid.

- First live run (8 Oct 00:07 PDT, `nvidia/nemotron-3-super-120b-a12b:free`, 14 steps, 79 s): KS-1001 paid; changed address, padded line, padded total, the hidden instruction and the wrong supplier all held, each for the right reason. The model sent the invoice text each time, paid the printed address (did not follow the hidden instruction), and told the person each held invoice with its link. Results: `apps/agent-runner/results/2026-10-08T07-07-07-245Z.json`.
- Free models: Gemma 4 (31B and 26B) were rate-limited upstream at the time; `thinkingmachines/inkling:free` only runs on agent harnesses. No Claude run without Afshal's yes.

## Still to do

1. WhatsApp live: Afshal signs in at developers.facebook.com and creates an app with WhatsApp (test number, his phone as a recipient); then the settings on Railway, the webhook URL (`/v1/whatsapp/webhook`), the template, and a held payment on his phone.
2. The approver app's "Connect WhatsApp" button (Sophie, `apps/approver/FEATURES.md`).
3. More real-agent runs across model families; Claude Code and claude.ai runs only with Afshal's yes.

## Next

Slice 15 (supplier address attestation wired in).
