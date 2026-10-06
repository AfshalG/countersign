# Countersign

**Check any payment. Enforce it on Monad.**

An AI agent reads a supplier invoice and drafts the payment. Countersign's checker compares the invoice with the purchase order the company approved. A match is paid from that order's vault on Monad. Anything that differs (a changed address, a padded amount, a duplicate, a hijacked agent) is held, and a person decides with Face ID. The rule lives in the account contract, so it holds whichever agent prepared the payment.

Built for Monad Metropolis 2026, Track 04.

## Status

Planning. The architecture is in [`docs/plan/00-architecture.md`](docs/plan/00-architecture.md). Code arrives slice by slice, starting with Slice 0 (tooling, CI, environment).

## Team

- [@AfshalG](https://github.com/AfshalG): contracts, gateway
- [@Rosh2403](https://github.com/Rosh2403): checker, MCP server
- [@sophiecloue](https://github.com/sophiecloue): approver app, supplier portal

## Contributing

- Never commit to `main`. Branch from `development` as `feature/…`, `fix/…` or `chore/…`, and merge back into `development` when the work is done and tested.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`.
- Secrets come from environment variables. Never commit `.env`.
