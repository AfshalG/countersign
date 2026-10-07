# Slice 13: Sign-in for agent apps

## Status

**BUILDING (7 Oct 2026).** Afshal chose WorkOS AuthKit ("yes go with workos"); the account is his. The MCP server's side (discovery, token checks) is built and tested without the account; the WorkOS settings and keys are added when the account exists. Technical decisions made by Claude.

## Goal

grok.com, ChatGPT (and dots, through ChatGPT's plugins), claude.ai and Codex can connect to the Countersign MCP server by signing in, the way they connect to any MCP server: the server answers 401 with where to sign in, the agent app registers itself with WorkOS (Client ID Metadata Document or Dynamic Client Registration), the person signs in with Google or email, and the app gets a token the server checks. Claude Code and scripts keep working with the bearer token.

## Prerequisites

- Slice 4: the connector spike and the table of how each agent app connects (grok.com: CIMD; ChatGPT: OAuth with CIMD or DCR, no bearer token; claude.ai: one custom connector on Free; Codex: `codex mcp login`).
- Slice 12: the MCP server on Vercel (`mcp-handler` 2.2.0), its six tools, the bearer token (`MCP_TOKEN`).
- A WorkOS account (Afshal's): AuthKit with Google and email sign-in, CIMD and DCR turned on, `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` in `.env`, the AuthKit domain.

## Checked against earlier slices and decisions

| Source | What carries into this slice |
|---|---|
| Slice 4 | grok.com registers with CIMD; ChatGPT accepts no bearer token, so it needs OAuth; tools never wait on a person; held results carry the link |
| Slice 12 | The MCP server is a Next.js route on Vercel built with webpack; the bearer token stays for Claude Code and the smoke test (`scripts/smoke.ts`); one demo account in hosted mode |
| D33 | Grok, dots, Muse and Claude are the agents the pitch names: sign-in is what lets the web ones connect |
| D34 | The name stays; the OAuth app is named Countersign |
| D24 | WorkOS holds sign-in identities (email, name); nothing about payments goes to WorkOS |
| Research (7 Oct) | WorkOS supports CIMD and DCR, issues JWTs whose `aud` is the registered resource indicator (the MCP URL), verified with `jose` against `https://<authkit domain>/oauth2/jwks`; free to 1M monthly users |
| Muse (Slice 4 update) | Muse prefers a bearer token: the token path stays |

## Design

1. **Discovery.** `GET /.well-known/oauth-protected-resource` (RFC 9728) names the MCP URL as the resource and WorkOS as the authorization server (`mcp-handler`'s `protectedResourceHandler`, with CORS for browser-based clients).
2. **Challenge.** A request with no valid token gets 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (`withMcpAuth`, required), which starts the agent app's sign-in.
3. **Two kinds of token.** The static bearer token (`MCP_TOKEN`, compared in constant time) for Claude Code, Codex and scripts; or a WorkOS access token (a JWT checked with `jose`: signature against WorkOS's JWKS, issuer `https://<authkit domain>`, audience the MCP URL, not expired). The signed-in user's id is logged with each call.
4. **The resource indicator.** The MCP URL is registered in WorkOS as the default resource indicator (through WorkOS's API with the key from `.env`), so tokens carry `aud` = the MCP URL even from clients that omit `resource`.
5. **Optional until configured.** Without `AUTHKIT_DOMAIN` the server accepts only the bearer token, as today; `loadEnv` gains optional settings for this.
6. **Accounts (limit, stated).** Every signed-in person uses the demo account in hosted mode for now; a person's own account comes with judge mode (Slice 9 part 4), keyed by their WorkOS user id.

## Tests first

The bearer token still works; no token is refused with the `resource_metadata` challenge; a JWT signed by a test key in a local JWKS, with the right issuer and audience, is accepted and its user id reaches the tools; a wrong audience, a wrong issuer, an expired token and a token signed by another key are refused; the discovery document names the resource and WorkOS; optional settings in `loadEnv`.

## Manual testing

1. The discovery document on the deployed server.
2. claude.ai: add the custom connector with the MCP URL; sign in with Google through WorkOS; `list_open_orders` answers.
3. grok.com and ChatGPT developer mode (whoever has the accounts; Afshal's are Singapore-region and Claude only).
4. The smoke test with the bearer token still passes.

## Next

Slice 9 part 2 (proposals approved on chain), then Slice 19.

