# Countersign

**The check outside the agent.** AI agents now pay for things. Countersign is an account on Monad that sits between any agent and the money: the owner sets, once, with a passkey, who can be paid, how much and until when (or several owners together, as many as the business requires). Inside those rules the agent pays with no click. Anything outside them waits for an owner. The rules live in the contract that holds the money, so a hijacked agent cannot get around them, and neither can we.

Built for Monad Metropolis 2026, Track 04 (Trust, Identity & AI Infrastructure). Testnet only.

## What works today (Monad testnet, chain 10143)

- **Passkeys verified on chain** through Monad's P256 precompile, from an iPhone, an Android phone and a Mac.
- **The account and per-order vaults** (`contracts/`): a vault pays only its supplier's address on file, within the order, each invoice once, with the agent's and the checker's signatures or the owners' passkeys. Refusing a look-alike address, a repeated invoice and a payment while paused, on chain. 119 Foundry tests.
- **Several approvers** (dual control): up to five owners per account, each with their own passkey. Adding a supplier, opening an order or paying a held payment once can need two of them, and any one can always pause or refuse.
- **The gateway** (`services/gateway`, hosted on Railway): takes payment requests, checks them, sends them through a pool of relayer wallets and marks them settled only at Monad's Finalized stage. Killed mid-run and restarted on testnet: 8 payments, 8 transactions, nothing paid twice.
- **A supplier's own website proving its payment address** (Primus zkTLS), checked on Monad.
- **The invoice checker** (`services/checker`, its own service, the only holder of the checker key): reads the invoice itself, compares it with the order's quote in code, asks Jev fixed yes-or-no questions only when code passed, and signs only when everything passed. Live on testnet, the padded line, the padded total and the hidden instructions are held and clean invoices settle (`services/gateway/results/2026-10-08-scripted-agent-checker.json`). Its [spec](docs/developers/checker-spec.md) lets anyone run their own.
- **Demo documents and an agent that pays them** (`apps/supplier`, `apps/scripted-agent`): a supplier's and a shop's [site](https://countersign-supplier-demo.vercel.app/demo) with quotes, invoices and checkouts, clean and doctored (a look-alike address, padding, hidden instructions, the wrong supplier, too much). An agent with no model read and paid all 14 cases live on testnet, and each ended as its document says (`services/gateway/results/2026-10-08-scripted-agent.json`).
- **Real agents paying the same documents** (`apps/agent-runner`): a model on OpenRouter, given Countersign's MCP tools and a page reader, pays six of the supplier's invoices at their links, not told which are doctored. NVIDIA Nemotron 3 Super paid the clean one, and the changed address, the padded line, the padded total, the hidden instruction and the wrong supplier were all held, each for the right reason (`apps/agent-runner/results/2026-10-08T07-07-07-245Z.json`).
- **The person asked in the chat**: on MCP's 2026-07-28 protocol, an agent app that can open links (Claude Code) shows the person a question with the approval link when a payment is held or a supplier proposed, and the agent then reports what they decided; other apps get the same link in the answer. Checked live on the hosted MCP server with the official MCP client.
- **The developer kit** (below): an SDK, an MCP server and a web API. A developer's own test account in one command (`countersign-test-account`): from an empty folder, the account was ready in 16 s and paid the supplier's clean invoice in 2.5 s, with a token that reaches only that account.

## Security model

Each claim comes with a test you can run (`forge test --match-test <name>` in `contracts/`, or `pnpm test`) or a transaction you can open on the [testnet explorer](https://testnet.monadexplorer.com).

1. **The passkey signs exactly what the contract checks.** Each owner's phone signs the action's EIP-712 digest as its WebAuthn challenge. The contract computes that digest itself, never taking one from the caller, verifies the signature through Monad's P256 precompile at `0x0100`, requires user verification (Face ID, fingerprint or PIN, not a bare tap) and refuses high-s signatures.
   Tests: `test_AnAssertionWithoutUserVerificationIsRefused`, `test_AHighSSignatureIsRefused`, `test_AnotherPasskeyCannotPay`, `test_AStrangersPasskeyInAnOwnersPlaceIsRefused`. On testnet: real passkeys from an iPhone, an Android phone and a Mac accepted by the [passkey probe](https://testnet.monadexplorer.com/address/0xa0b9d0408af2fd0d2b164fdd97757dc6029b7e97); a held payment paid once with the owner's passkey, [`payWithOwner`](https://testnet.monadexplorer.com/tx/0x7fdc16ae7419022c191b8a0dd4db44330dc34584ca412581a7d6f2338093cf52).
2. **The contract enforces the rules, not our servers.** A payment needs the agent's and the checker's signatures in the vault's own EIP-712 domain (chain ID and vault address), so a signature for one vault or chain is useless anywhere else. The vault pays only the supplier's address on file; not even the owners' passkeys can send it elsewhere.
   Tests: `test_PaysOnlyTheAddressOnFile`, `test_TheOwnerStillPaysOnlyTheAddressOnFile`, `test_SignaturesForAnotherVaultAreRefused`, `test_SignaturesForAnotherChainAreRefused`, `test_TheCheckerSignatureAloneIsNotEnough`, `test_RefusesTheSameInvoiceTwice`. On testnet: a look-alike address [held by the gateway](https://gateway-production-e17a.up.railway.app/p/0x6d4aa8a84b25735263e97ab7cc2dad9936b054f966a0ae1ebcf7e18579e83fec) (the contract refuses it with `PayToNotOnFile`); a clean payment [settled](https://testnet.monadexplorer.com/tx/0x0dc68405b27fab8b49aa73d9691645c3547f34e618f30b310e12878360f254e7).
3. **Addresses are proven, not typed in.** Primus zkTLS proves the supplier's own website lists the address. Our verifier pins the URL, every request field and the proof's age, which closes three gaps in Primus's own verifier (it does not check the timestamp, it packs fields without separators, and its attestor list is unsigned). On testnet: the [probe](https://testnet.monadexplorer.com/address/0xF469cEC069AEAa068238c50e70FE682a794E6ca6) refused a supplier file changed to another address (`AddressDiffers`). Wiring it into supplier approval is Slice 15.
4. **The model can only hold.** Code makes every release decision. The checker reads the invoice and compares it with the order in code; only then does its model (Jev) answer fixed yes-or-no questions, and any doubtful answer, error or timeout is a hold. A model answering "all fine" never releases a payment that failed a code check, and the checker's signature alone cannot pay.
   Tests: "D27: every code failure stays held whatever the model says, and the model is not asked" and "holds when the model fails or runs out of time (fail closed)" in `services/checker/test/check.test.ts`; "holds when the checker errors or runs out of time (fail closed)" in `services/gateway/test/pipeline/check.test.ts`; `test_TheCheckerSignatureAloneIsNotEnough`. On testnet: every demo invoice checked with the real model (`services/checker/results/2026-10-08-demo-with-jev.json`).
5. **Nothing is paid twice, even through a crash.** An invoice's identity is fixed by its supplier and number; the vault refuses a second payment, and the gateway re-sends a signed transaction unchanged after a restart. On testnet: the gateway killed mid-run and restarted, 8 payments, 8 transactions (`services/gateway/results/2026-10-07-testnet.json`).
6. **No leaked secrets.** Keys come from environment variables only; every commit is scanned with gitleaks; the gateway and the MCP server have their own service tokens; the checker key lives only in the checker service (the gateway holds none); the MCP server's upload to Vercel is an allow-list that never includes `.env`.
7. **Every payment can be tied to its registered agent (ERC-8004).** Countersign's agents are registered in Monad testnet's ERC-8004 Identity Registry ([`0x8004A818…BD9e`](https://testnet.monadexplorer.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)): agent 2066, the hosted agent behind the MCP tools, and agent 2067, judge mode's demo agent. Each agent's `agentWallet` is the key that signs its payments, set with that key's EIP-712 consent. A payment's agent signature is in its own transaction, so anyone can recover the signer and compare it with `getAgentWallet(agentId)`; the gateway shows the agent on every payment and re-reads each agent's wallet when it starts. The vaults do not check identity: the registry says who the agent is, and the contract's rules still decide what is paid.
   Tests: "which agent signed a payment (ERC-8004)" in `services/gateway/test/agents.test.ts`; the `AgentWalletSet` digest against one derived from the registry's source in `packages/shared/test/erc8004.test.ts`. On testnet: agent 2066 [registered](https://testnet.monadexplorer.com/tx/0xfa658c16655c9e7504747eac094897969bf802c02294fa7e67e0ed3b7972aba8) and its [wallet set](https://testnet.monadexplorer.com/tx/0xc55c9b450d147ebb62bb68fe333ecab69f614b6207dfe8bddbf586256c88b0da); its [registration file](https://countersign-mcp.vercel.app/agents/countersign-hosted.json).
8. **One person cannot add a supplier alone when the account requires two.** An account's owners and its two thresholds are in the contract: **manage** (suppliers, orders, the rules, the owners, unpausing) and **release** (paying a held payment once). The contract counts the owners' signatures itself, each owner once, in owner order; any one owner can still pause or refuse, so stopping money never waits for a second person.
   Tests: `test_WithTwoRequiredOneOwnerCannotAddASupplier`, `test_OneOwnerCannotCountTwice`, `test_PayingOnceNeedsTheReleaseThreshold`, `test_AnyOneOwnerCanPause`, `test_UnpausingNeedsTheManageThreshold`, `test_ARemovedOwnersPasskeyStopsWorking`. On testnet, an account with two owners: a supplier added by one of them refused (`NotEnoughSigners`), by both [added](https://testnet.monadexplorer.com/tx/0x46ac7185cc6801c218702cdcfbc08d1162fb0c85ec436715a3188bc13ed338af); [paused by one](https://testnet.monadexplorer.com/tx/0xb04fbcbc1ff569dbe70ae74fa09996d37ba16724f7f73a774cc8bdcba5e4df2f), [unpaused by both](https://testnet.monadexplorer.com/tx/0xa619da356923897bba008ea19fa303759f48683e242d3ac43abc99f2621e166c); a held payment [paid once by both](https://testnet.monadexplorer.com/tx/0xb601ae0a054502641c9e43b4cb893da376e7d2daa5cf998465b86b70aff30acc).

## Build on it

|                              | For                                                                                                                                                                                           | Where                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SDK** (`@countersign/sdk`) | Your own agent, in TypeScript. Its key signs locally and never leaves your process                                                                                                            | [`packages/sdk`](packages/sdk)                                                                                                                    |
| **MCP server**               | Any MCP agent: claude.ai, Grok and ChatGPT by signing in (WorkOS), Claude Code and Codex with a token. Six tools: list orders, check, pay, pay a run, look up a status, propose an order      | `https://countersign-mcp.vercel.app/api/mcp`                                                                                                      |
| **A2A**                      | Agents on Google's Agent2Agent protocol (ADK, Azure AI Foundry, Bedrock AgentCore, Agentforce): the same six skills; a held payment is an `auth-required` task with the owner's approval link | [Agent Card](https://countersign-mcp.vercel.app/.well-known/agent-card.json) · JSON-RPC at `/api/a2a`                                             |
| **Web API**                  | Anything that speaks HTTP                                                                                                                                                                     | [Reference](https://gateway-production-e17a.up.railway.app/docs) · [`/openapi.json`](https://gateway-production-e17a.up.railway.app/openapi.json) |

```ts
import { Countersign } from '@countersign/sdk';

const cs = new Countersign({ gateway, token, account, agentKey });
const [order] = await cs.orders();
const result = await cs.pay({
  order,
  invoice: { number: 'INV-0042', amount: '12.50', payTo: '0x90f9…5fEc' },
  wait: true,
});
// 'settled', or 'held' with the reason in plain words and a link for the owner
```

Start with the [developer quickstart](docs/developers/quickstart.md). Coding agents (Claude Code, Cursor, Codex, Muse) can read [`llms.txt`](https://gateway-production-e17a.up.railway.app/llms.txt) or everything in [one file](https://gateway-production-e17a.up.railway.app/llms-full.txt).

## Stated limits

- **The contract is the boundary; the checker is a detector.** The contract makes paying the wrong party impossible. The checker catches the right supplier billing the wrong amount; we publish its catch rate and false holds rather than claim it is perfect.
- **The checker reads the invoice the agent sends.** A hijacked agent could send a clean text with a padded payment; the contract still keeps it to an approved supplier and order. Reading the invoice from the supplier's own site is next.
- **Hosted mode** (the MCP server) holds the agent key and the checker key for you, in separate services. The contract's limits still bound what they could pay: suppliers on file, within approved orders.
- **Test accounts are self-serve, with a key standing in for the passkey.** `countersign-test-account` makes a developer's own testnet account and a token for it alone; its owner is a P-256 key in a file, not Face ID on a phone. The hosted MCP server still pays from a shared demo account.
- **Name.** Another project uses the name Countersign (countersign.network, an off-chain spend guard for agent wallets); we may rename after the hackathon.

The full plan, decisions and limits are in [`docs/plan/00-architecture.md`](docs/plan/00-architecture.md).

## Repository

| Path               | What                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `contracts/`       | Solidity (Foundry): the account, order vaults, the factory           |
| `packages/sdk`     | The SDK                                                              |
| `packages/shared`  | Typed statuses and reasons, EIP-712 types, invoice ids, USDC amounts |
| `packages/chain`   | Monad config, ABIs                                                   |
| `services/gateway` | The gateway (Hono, Postgres)                                         |
| `services/mcp`     | The MCP server (Next.js, `mcp-handler`)                              |
| `spikes/`          | Throwaway proofs: passkeys, Primus, payment runs, agent connectors   |

## Getting started

You need Node 24 (`nvm install 24`), pnpm through Corepack (`corepack enable`) and Foundry (`curl -L https://foundry.paradigm.xyz | bash`, then `foundryup`).

```bash
pnpm install
pnpm check            # typecheck, lint, format check, tests
pnpm test:contracts   # installs OpenZeppelin through Soldeer, then forge test
cp .env.example .env  # fill in values when a slice needs them
```

## Team

- [@AfshalG](https://github.com/AfshalG): contracts, gateway
- [@Rosh2403](https://github.com/Rosh2403): checker, MCP server
- [@sophiecloue](https://github.com/sophiecloue): approver app, supplier portal

## Contributing

- Never commit to `main`. Branch from `development` as `feature/…`, `fix/…` or `chore/…`, and merge back into `development` when the work is done and tested.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`.
- Secrets come from environment variables. Never commit `.env`.

MIT licensed.
