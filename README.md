# Countersign

**Check any payment. Enforce it on Monad.**

An AI agent reads a supplier invoice and drafts the payment. Countersign's checker compares the invoice with the purchase order the company approved. A match is paid from that order's vault on Monad. Anything that differs (a changed address, a padded amount, a duplicate, a hijacked agent) is held, and a person decides with Face ID. The rule lives in the account contract, so it holds whichever agent prepared the payment.

Built for Monad Metropolis 2026, Track 04.

## Status

Planning. The architecture is in [`docs/plan/00-architecture.md`](docs/plan/00-architecture.md). Slice 0 (tooling, CI, environment) is done. Code arrives slice by slice.

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
