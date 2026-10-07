# Spike 3: 200 payments on Monad testnet, a vault per order against one account

Throwaway code. Never imported by product code. Plan and full results: `docs/plan/slice-03-payment-run.md`.

**Status (7 Oct 2026): vaults against one account answered; the 1-wallet, 10-supplier and duplicate runs wait on testnet MON.**
At 200 payments, a vault per order was not faster than one shared account: the chain finalized both in
about 0.6 s, and the gap between the runs came from one endpoint's slow forwarding. Vaults stay, for
isolation and slightly lower gas, not speed.

| Measure (200 payments to 200 suppliers)  | Vaults                 | One account            |
| ---------------------------------------- | ---------------------- | ---------------------- |
| First send to last finalized, 8 wallets  | 5.4 s                  | 6.3 s                  |
| Of which, sending alone                  | 4.4 s                  | 4.5 s                  |
| One payment, send to finalized           | p50 0.95 s, p95 1.12 s | p50 0.97 s, p95 2.22 s |
| Proposed to finalized (the chain itself) | p50 592 ms             | p50 576 ms             |
| Execution gas per payment                | 147,314                | 153,459                |
| Creating and funding an order            | 109,300 gas            | 62,100 gas             |
| First send to last finalized, 4 wallets  | 11.4 s                 |                        |

Gas per payment is for a supplier that already holds USDC; a first payment to a supplier costs about
17k more. Each payment costs about 0.016–0.018 testnet MON, charged on the gas limit.

Deployed on testnet (chain 10143): `VaultFactory` `0xD302044D86E017d84eD6201eF87474D3eb30cf5e`,
`SharedAccount` `0x83F4db7781bb067Faeb95F0FD16980F708bEB5d3`. Every transaction's record is in `results/`.

## What we learned about Monad

- **A USDC payment costs about 165k gas**, twice what we planned: Monad prices first access to an account at 10,100 gas and to a storage page at 8,100.
- **Receipts report `gasUsed` equal to the gas limit**, so execution gas comes from `eth_estimateGas`.
- **Out-of-order nonces are lost, not held.** Spreading one wallet's transactions across endpoints let later nonces reach a node first; they vanished and needed re-sending. Sending each wallet's nonces in order through one endpoint lost none.
- **Under 10 MON, an account can move MON out only once per 3 blocks** (reserve balance), so the relayers are funded in one Multicall3 transaction.
- **An endpoint can accept transactions and never forward them** (monadinfra, twice). Each wallet fails over to the next endpoint if its lowest pending nonce is not finalized 3 s after acceptance; `--simulate-dead-endpoint` tests this with a local endpoint that drops everything.
- **Each wallet sends about 6 to 10 payments a second**, so the pool's size sets a run's speed.
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
