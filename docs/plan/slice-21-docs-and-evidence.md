# Slice 21: Developer docs and evidence pack

## Status

**DONE (8 Oct 2026).** Built by Claude; README, security model, quickstart and llms.txt were done early (Slices 12, 13, 16 to 18) and brought up to date here.

## Goal

Everything a judge, a developer or an auditor needs to check a claim without asking us: what works today, with its proof; where data goes (D24); the stated limits; what is deployed; and how to reproduce a run.

## Checked against the code and the chain, not copied from the plan

| Claim in the docs | How it was checked |
| --- | --- |
| The checker's model sees invoices only through providers that keep nothing | `services/checker/src/model.ts`: both models are asked with `data_collection: 'deny'` and `zdr: true` (OpenRouter refuses rather than route elsewhere, checked 7 Oct) |
| Logs carry ids, supplier website addresses and errors, not documents | every `console.*` in the gateway and checker read |
| Sign-in goes to WorkOS; WhatsApp to Meta (off today) | `services/mcp/lib/auth.ts`, `services/gateway/src/notify/whatsapp-api.ts` |
| Each deployed address is live | `eth_getCode` on Monad testnet for the factory, both templates, `SupplierProofs`, the probes, the ERC-8004 registry and USDC (8 Oct) |
| The run boards still serve | `/r/{runId}?format=json` for the runs of 200, 100 and 20 (8 Oct) |
| Bank-transfer advice, live | rerun through the hosted MCP server and saved (`services/gateway/results/2026-10-08-advice-live.json`) |
| Test counts | `pnpm check` 676, `forge test` 138 (8 Oct) |

## Built

1. **README**: "Where your data goes" (D24), a "Deployed" list (contracts and services), the benchmark in "What works today", security claim 9 (decisions on Monad), four new stated limits (bank transfers get advice; not every decision is on chain; relayer gas; the benchmark's computed arms), the repository table brought up to date, and a stale line fixed (Primus wired into approval since Slice 15).
2. **`docs/evidence.md`**: each claim with its transaction, test or results file, and how to reproduce a run.
3. **llms.txt**: bank-transfer advice and verifiable records for coding agents; links to the data table and the evidence.
4. **`.env.example`**: the optional settings and the scripts' keys, by name.

## Next

Slice 22 (demo, pitch, video, submission).
