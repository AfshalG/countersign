# Spike 3: 200 payments on Monad testnet, a vault per order against one account

Throwaway code. Never imported by product code. Plan and full results: `docs/plan/slice-03-payment-run.md`.

**Status (7 Oct 2026): the vault run is done; the one-account run and the rest wait on testnet MON.**
200 USDC payments from 200 vaults to 200 suppliers, sent through 8 relayer wallets, all settled with
none lost or re-sent.

| Measure (200 payments, vaults, 8 wallets)    | Value                                           |
| -------------------------------------------- | ----------------------------------------------- |
| First send to last finalized                 | 5.4 s                                           |
| Of which, sending alone                      | 4.4 s (the public endpoints' limits)            |
| One payment, send to finalized               | p50 0.95 s, p95 1.12 s                          |
| Blocks used / most payments in one block     | 16 / 21                                         |
| Execution gas per payment, vault/one account | 164,449 / 171,771 (first payment to a supplier) |
| Creating and funding a vault / an order      | 109,300 / 62,100 gas                            |
| MON per payment (charged on the gas limit)   | about 0.018                                     |

Deployed on testnet (chain 10143): `VaultFactory` `0xD302044D86E017d84eD6201eF87474D3eb30cf5e`,
`SharedAccount` `0x83F4db7781bb067Faeb95F0FD16980F708bEB5d3`. Every transaction's record is in `results/`.

## What we learned about Monad

- **A USDC payment costs about 165k gas**, twice what we planned: Monad prices first access to an account at 10,100 gas and to a storage page at 8,100.
- **Receipts report `gasUsed` equal to the gas limit**, so execution gas comes from `eth_estimateGas`.
- **Out-of-order nonces are lost, not held.** Spreading one wallet's transactions across endpoints let later nonces reach a node first; they vanished and needed re-sending. Sending each wallet's nonces in order through one endpoint lost none.
- **Under 10 MON, an account can move MON out only once per 3 blocks** (reserve balance), so the relayers are funded in one Multicall3 transaction.
- **The public endpoints set a run's speed:** batches give no extra throughput, and Monad's endpoint limits `eth_call` to 15 a second.

## Run it

```bash
pnpm install
cd spikes/03-payments
forge soldeer install && forge test -vv               # 22 tests, fuzzing included
pnpm run open-orders s1                                # 200 vaults and 200 one-account orders (needs ../../.env)
pnpm run run-scenario --arm vaults --wallets 8 --label <new-label> --dry-run   # cost, nothing sent
pnpm run run-scenario --arm vaults --wallets 8 --label <new-label>
pnpm run run-scenario --arm account --wallets 8 --label <new-label>
pnpm run run-scenario --arm vaults --wallets 8 --scenario duplicates --label <new-label>
```

A label pays its invoices once, so each run needs a new one. `--count 10` runs a smoke test.
