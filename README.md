# Countersign

**The check outside the agent.** AI agents now pay for things. Countersign is an account on Monad that sits between any agent and the money: the owner sets, once, with a passkey, who can be paid, how much and until when. Inside those rules the agent pays with no click. Anything outside them waits for the owner. The rules live in the contract that holds the money, so a hijacked agent cannot get around them, and neither can we.

Built for Monad Metropolis 2026, Track 04 (Trust, Identity & AI Infrastructure). Testnet only.

## What works today (Monad testnet, chain 10143)

- **Passkeys verified on chain** through Monad's P256 precompile, from an iPhone, an Android phone and a Mac.
- **The account and per-order vaults** (`contracts/`): a vault pays only its supplier's address on file, within the order, each invoice once, with the agent's and the checker's signatures or the owner's passkey. Refusing a look-alike address, a repeated invoice and a payment while paused, on chain. 105 Foundry tests.
- **The gateway** (`services/gateway`, hosted on Railway): takes payment requests, checks them, sends them through a pool of relayer wallets and marks them settled only at Monad's Finalized stage. Killed mid-run and restarted on testnet: 8 payments, 8 transactions, nothing paid twice.
- **A supplier's own website proving its payment address** (Primus zkTLS), checked on Monad.
- **The developer kit** (below): an SDK, an MCP server and a web API.

## Build on it

|                              | For                                                                                                                    | Where                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SDK** (`@countersign/sdk`) | Your own agent, in TypeScript. Its key signs locally and never leaves your process                                     | [`packages/sdk`](packages/sdk)                                                                                                                    |
| **MCP server**               | Any MCP agent (Claude Code today): six tools to list orders, check, pay, pay a run, look up a status, propose an order | `https://countersign-mcp.vercel.app/api/mcp`                                                                                                      |
| **Web API**                  | Anything that speaks HTTP                                                                                              | [Reference](https://gateway-production-e17a.up.railway.app/docs) · [`/openapi.json`](https://gateway-production-e17a.up.railway.app/openapi.json) |

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

Start with the [developer quickstart](docs/developers/quickstart.md).

## Stated limits

- **The contract is the boundary; the checker is a detector.** The contract makes paying the wrong party impossible. The checker catches the right supplier billing the wrong amount; we publish its catch rate and false holds rather than claim it is perfect.
- **Hosted mode** (the MCP server) holds the agent key and the checker key for you, in separate services. The contract's limits still bound what they could pay: suppliers on file, within approved orders.
- **Self-serve accounts arrive with the passkey app (Slice 9).** Until then, ask us for a testnet account and token.
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
