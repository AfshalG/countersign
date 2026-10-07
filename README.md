# Countersign

**The check outside the agent.** AI agents now pay for things. Countersign is an account on Monad that sits between any agent and the money: the owner sets, once, with a passkey, who can be paid, how much and until when. Inside those rules the agent pays with no click. Anything outside them waits for the owner. The rules live in the contract that holds the money, so a hijacked agent cannot get around them, and neither can we.

Built for Monad Metropolis 2026, Track 04 (Trust, Identity & AI Infrastructure). Testnet only.

## What works today (Monad testnet, chain 10143)

- **Passkeys verified on chain** through Monad's P256 precompile, from an iPhone, an Android phone and a Mac.
- **The account and per-order vaults** (`contracts/`): a vault pays only its supplier's address on file, within the order, each invoice once, with the agent's and the checker's signatures or the owner's passkey. Refusing a look-alike address, a repeated invoice and a payment while paused, on chain. 105 Foundry tests.
- **The gateway** (`services/gateway`, hosted on Railway): takes payment requests, checks them, sends them through a pool of relayer wallets and marks them settled only at Monad's Finalized stage. Killed mid-run and restarted on testnet: 8 payments, 8 transactions, nothing paid twice.
- **A supplier's own website proving its payment address** (Primus zkTLS), checked on Monad.
- **The developer kit** (below): an SDK, an MCP server and a web API.

## Security model

Each claim comes with a test you can run (`forge test --match-test <name>` in `contracts/`, or `pnpm test`) or a transaction you can open on the [testnet explorer](https://testnet.monadexplorer.com).

1. **The passkey signs exactly what the contract checks.** The owner's phone signs the action's EIP-712 digest as its WebAuthn challenge. The contract computes that digest itself, never taking one from the caller, verifies the signature through Monad's P256 precompile at `0x0100`, requires user verification (Face ID, fingerprint or PIN, not a bare tap) and refuses high-s signatures.
   Tests: `test_AnAssertionWithoutUserVerificationIsRefused`, `test_AHighSSignatureIsRefused`, `test_AnotherPasskeyCannotPay`. On testnet: real passkeys from an iPhone, an Android phone and a Mac accepted by the [passkey probe](https://testnet.monadexplorer.com/address/0xa0b9d0408af2fd0d2b164fdd97757dc6029b7e97); a held payment paid once with the owner's passkey, [`payWithOwner`](https://testnet.monadexplorer.com/tx/0x7fdc16ae7419022c191b8a0dd4db44330dc34584ca412581a7d6f2338093cf52).
2. **The contract enforces the rules, not our servers.** A payment needs the agent's and the checker's signatures in the vault's own EIP-712 domain (chain ID and vault address), so a signature for one vault or chain is useless anywhere else. The vault pays only the supplier's address on file; not even the owner's passkey can send it elsewhere.
   Tests: `test_PaysOnlyTheAddressOnFile`, `test_TheOwnerStillPaysOnlyTheAddressOnFile`, `test_SignaturesForAnotherVaultAreRefused`, `test_SignaturesForAnotherChainAreRefused`, `test_TheCheckerSignatureAloneIsNotEnough`, `test_RefusesTheSameInvoiceTwice`. On testnet: a look-alike address [held by the gateway](https://gateway-production-e17a.up.railway.app/p/0x6d4aa8a84b25735263e97ab7cc2dad9936b054f966a0ae1ebcf7e18579e83fec) (the contract refuses it with `PayToNotOnFile`); a clean payment [settled](https://testnet.monadexplorer.com/tx/0x0dc68405b27fab8b49aa73d9691645c3547f34e618f30b310e12878360f254e7).
3. **Addresses are proven, not typed in.** Primus zkTLS proves the supplier's own website lists the address. Our verifier pins the URL, every request field and the proof's age, which closes three gaps in Primus's own verifier (it does not check the timestamp, it packs fields without separators, and its attestor list is unsigned). On testnet: the [probe](https://testnet.monadexplorer.com/address/0xF469cEC069AEAa068238c50e70FE682a794E6ca6) refused a supplier file changed to another address (`AddressDiffers`). Wiring it into supplier approval is Slice 15.
4. **The model can only hold.** Code makes every release decision. The checker's model answers fixed yes-or-no questions, and its yes, its errors and its timeouts all become holds; its signature alone cannot pay.
   Tests: "holds when the checker errors or runs out of time (fail closed)" in `services/gateway/test/pipeline/check.test.ts`; `test_TheCheckerSignatureAloneIsNotEnough`. The invoice-reading checker is Slice 10.
5. **Nothing is paid twice, even through a crash.** An invoice's identity is fixed by its supplier and number; the vault refuses a second payment, and the gateway re-sends a signed transaction unchanged after a restart. On testnet: the gateway killed mid-run and restarted, 8 payments, 8 transactions (`services/gateway/results/2026-10-07-testnet.json`).
6. **No leaked secrets.** Keys come from environment variables only; every commit is scanned with gitleaks; the gateway and the MCP server have their own service tokens; the MCP server's upload to Vercel is an allow-list that never includes `.env`.
7. **Agent identity on ERC-8004** (planned, Slice 19): every settled payment will record which registered agent paid.

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

Start with the [developer quickstart](docs/developers/quickstart.md). Coding agents (Claude Code, Cursor, Codex, Muse) can read [`llms.txt`](https://gateway-production-e17a.up.railway.app/llms.txt) or everything in [one file](https://gateway-production-e17a.up.railway.app/llms-full.txt).

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
