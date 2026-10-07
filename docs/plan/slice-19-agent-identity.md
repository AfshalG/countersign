# Slice 19: Agent identity on ERC-8004, and the A2A door

## Status

**DONE (7 Oct 2026).** Part A (ERC-8004 identity) and Part B (the A2A door) live on testnet.

## Goal

Every payment through Countersign can be tied to a registered agent, by anyone, from public data: the agent's key that signs each payment is that agent's `agentWallet` in Monad's ERC-8004 Identity Registry. The gateway shows the agent's ERC-8004 id on every payment. Agents that speak A2A (Google ADK, Azure AI Foundry, Bedrock AgentCore, Agentforce) can pay through Countersign as they reach other agents, beside the MCP and HTTP doors.

## Prerequisites

- Slice 5: the deployed `Payment` struct (amount, invoiceHash, payTo, deadline) signed by the agent's key and the checker's key in the vault's EIP-712 domain; the policy names the agent key.
- Slice 9: judge mode's demo agent key (named in every demo account's policy).
- Slice 12: the SDK, the MCP server (hosted mode, one account, `AGENT_PRIVATE_KEY`), the gateway's payment views.
- Slice 13: sign-in through WorkOS (the A2A door uses the same tokens).
- Research `research/2026-10-07-a2a-erc8004-auth.md`, and this slice's checks below.

## Checked on chain and in the source (7 Oct)

| What | Finding |
|---|---|
| Identity Registry, testnet | `0x8004A818BFB912233c491871b3d84c89A494BD9e`, a UUPS proxy (implementation `0x7274e874…9c02`), `getVersion()` 2.0.0, `name()` "AgentIdentity"; agents already registered |
| Its EIP-712 domain (`eip712Domain()`) | "ERC8004IdentityRegistry", version "1", chain 10143, the proxy as verifying contract |
| `register(string agentURI)` | mints the agent (ERC-721) to the caller and sets `agentWallet` to the caller |
| `setAgentWallet(agentId, newWallet, deadline, signature)` | only the agent's owner (or approved) calls it; `newWallet` signs EIP-712 `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)`; the deadline at most 5 minutes ahead; ECDSA, else ERC-1271. A transfer of the agent clears the wallet |
| Second registry `0x8004B663056A597Dffe9eCcC1965A193B7388713` | the **Reputation Registry** (its implementation has `giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)`; `getIdentityRegistry()` is the registry above) |
| Validation Registry | **not on testnet** (Monad's guide: "coming soon" on mainnet). Decision records as validation responses are out of scope |
| Source | `erc-8004/erc-8004-contracts`, `IdentityRegistryUpgradeable.sol` |

## Checked against earlier slices and decisions

| Source | What carries into this slice |
|---|---|
| Slice 5 | The deployed `Payment` struct has no agent id, and redeploying the vaults is not wanted (D35 left it to this slice): **decided, no redeploy**. The agent's signature is already in every payment's calldata, so the signer is public; ERC-8004 maps that signer to an agent |
| Slice 6 | Registration transactions are one-off operator actions from the deployer (it holds MON), not relayer traffic |
| Slice 9 | The demo agent signs payments into judges' accounts: registered too, so judges see an agent id |
| Slice 12 | Hosted mode signs with `AGENT_PRIVATE_KEY` for the demo account: registered as Countersign's hosted agent; the SDK's `PaymentRequest` gains the agent (additive) |
| Slice 13 | The A2A door accepts the same WorkOS tokens and the bearer token as the MCP door |
| D24 | The registration file is public: names and endpoints only, no business data |
| D33 | Track 04 names ERC-8004: the pitch says "this week: ERC-8004 agent identity" and README claim 7 promises it; both must be true when this slice is done |
| Pitch hygiene | Claim only what is verifiable: "anyone can tie a payment to its registered agent", not "the contract checks the agent's identity" (it does not) |

## Design

**Part A: identity.**
1. **Registration files** served by the MCP server at `/agents/{name}.json` in the ERC-8004 format (`type`, `name`, `description`, `services` with MCP and A2A endpoints, `registrations` with the agent id and `eip155:10143:0x8004A818…`, `supportedTrust: ["reputation"]`).
2. **`scripts/register-agent.ts`**: the deployer calls `register(agentURI)`, then `setAgentWallet(agentId, agentKey, deadline, sig)` with the agent key's EIP-712 signature; prints the agent id. Run for Countersign's hosted agent and the judge-mode demo agent.
3. **The gateway records the agent**: `POST /v1/agents { agentId }` (service token) reads `getAgentWallet(agentId)` and `ownerOf(agentId)` from the registry and stores the agent; every payment view gains `agent: { address, agentId, registry } | null`, the address recovered from the payment's agent signature (the vault's own digest), the id from the stored agents whose wallet still matches on chain. Shown on the status page, in the API, the SDK and the MCP tools' answers.
4. **README claim 7** rewritten with the evidence: the registration transactions, an agent id, and a payment tied to it.

**Part B: the A2A door** (on the MCP server, with `@a2a-js/sdk`): an Agent Card at `/.well-known/agent-card.json` (skills: pay an invoice, check an invoice, list open orders, payment status, propose an order; the same auth as MCP), a JSON-RPC endpoint, an `AgentExecutor` calling our SDK; task states: held → `auth-required` with the approval link, settled → `completed` with the transaction as an artifact, refused or blocked → `rejected`. Planned in detail (and the SDK's v1.0 API checked) when Part A is done.

**Not in this slice:** reputation feedback (`giveFeedback` costs gas per payment; a refusal-only feedback is a candidate for later), validation records (no testnet registry).

## Tests first

Part A: the `AgentWalletSet` digest against the registry's own (`eip712Domain` values; a signature that recovers to the agent key); the registration file's shape; the agent recovered from a payment's signature; a payment from a registered key shows its agent id, from an unknown key `null`; `POST /v1/agents` refuses an id whose wallet is not a known agent key or does not exist.

## Manual testing

Register both agents on testnet; a payment through the hosted gateway shows the agent id; `getAgentWallet(agentId)` on the explorer equals the payment's signer.

## Results, part A (7 Oct 2026, Monad testnet)

| Step | Result |
|---|---|
| Agent 2066, the hosted agent behind the MCP tools | registered by the deployer (tx `0xfa658c16655c9e7504747eac094897969bf802c02294fa7e67e0ed3b7972aba8`); `agentWallet` set to `0x0f92A10b64B4A177cB1E090edC317C4202f71DC3`, the demo account's policy agent key, with its EIP-712 consent (tx `0xc55c9b450d147ebb62bb68fe333ecab69f614b6207dfe8bddbf586256c88b0da`) |
| Agent 2067, judge mode's demo agent | registered (tx `0x171cb487cfe6d2e24b628cd16d6b10f629f23cd3a26a1210bacb42e1efb1a689`); wallet `0xEB6F67971df18a0b26CE81dC19fF3a3560ec5Df3` (tx `0x9532234da5fa76460c227bf246f9129cad0f23cee54d21edbf2eb0aee224e2e0`) |
| The gateway names both (`POST /v1/agents`, read from the registry) | `eip155:10143:0x8004A818…`, wallets as above |
| A fresh payment from the demo account (held, no MON spent) | its view shows `agent: { address: 0x0f92…, agentId: "2066" }` |
| Registration files | `https://countersign-mcp.vercel.app/agents/countersign-hosted.json` (and `countersign-demo.json`), in the ERC-8004 format with MCP and A2A services |
| Tests | 351, including 4 for agent identity in the gateway, 2 for the ERC-8004 shared module, 1 for the registration files |

### Findings, carried forward

1. **`register()` makes the caller the agent's first wallet**, and a transfer of the agent clears its wallet: Countersign's agents are owned by the deployer and their wallets set explicitly. → Slice 21 (docs for agent builders: register, then set the wallet to your signing key).
2. **No reverse lookup in the registry** (wallet to agent id): the gateway keeps the agents it names and re-reads each wallet at start. An agent builder adds their agent with `POST /v1/agents`. → Slice 21.
3. **Payments before this slice have no recorded agent** (the column is new); only new ones show it.

## Results, part B (7 Oct 2026, live)

`pnpm --filter @countersign/mcp-server a2a-smoke` against `https://countersign-mcp.vercel.app`, with the A2A project's own client (`@a2a-js/sdk` 1.3.0):

| Step | Result |
|---|---|
| The Agent Card | read by the client; JSON-RPC interfaces for A2A 1.0 and 0.3; six skills |
| `list_open_orders` | `TASK_STATE_COMPLETED`, the orders as a data part |
| `pay_invoice` to a look-alike (same first six and last four characters) | `TASK_STATE_AUTH_REQUIRED`: "Held; nothing was paid", both addresses, the owner's approval link; signed by agent #2066 (shown on the status page) |
| Tests | 358, including 7 A2A tests through the official client (card, no token, orders, a settled payment, a hold, plain text, bad arguments) |

### Findings, carried forward (part B)

4. **A caller that omits `A2A-Version` speaks 0.3** (the spec's default): the card declares JSON-RPC 1.0 and 0.3, and 0.3 calls go to the SDK's legacy transport. → Slice 21 (docs).
5. **Tasks live in memory** (`InMemoryTaskStore`) on a serverless function: `GetTask` may not find a task after the function restarts. Every answer already carries the outcome (and the status link), so nothing depends on it. → Later, a Postgres task store if an A2A client polls.
6. **Streaming is not offered** (`capabilities.streaming: false`): every skill answers in seconds.
7. **"Paid by agent" on a held payment was wrong** (seen in the live walkthrough): the status page now says "Sent by agent" until the payment settles.

## Next

Slice 7 (the supplier portal and the demo documents).

