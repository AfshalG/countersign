# Evidence

Each claim Countersign makes, with what proves it: a transaction on Monad testnet (chain 10143), a test you can run, or a results file from a live run. Nothing here needs our servers to be honest: transactions are on [the explorer](https://testnet.monadexplorer.com), tests run from a clone, and a payment's record can be checked against Monad with `npx countersign-verify`.

Run every test: `pnpm install && pnpm check` (676 TypeScript tests) and `pnpm test:contracts` (138 Foundry tests).

## The contract is the boundary

| Claim | Proof |
| --- | --- |
| Passkeys are verified on chain (Monad's P256 precompile), with user verification required and high-s signatures refused | `test_AnAssertionWithoutUserVerificationIsRefused`, `test_AHighSSignatureIsRefused`; real passkeys from an iPhone, an Android phone and a Mac accepted by the [passkey probe](https://testnet.monadexplorer.com/address/0xa0b9d0408af2fd0d2b164fdd97757dc6029b7e97) |
| A vault pays only its supplier's address on file, even for the owners | `test_PaysOnlyTheAddressOnFile`, `test_TheOwnerStillPaysOnlyTheAddressOnFile`; a look-alike address [held](https://gateway-production-e17a.up.railway.app/p/0x6d4aa8a84b25735263e97ab7cc2dad9936b054f966a0ae1ebcf7e18579e83fec) (`PayToNotOnFile`) |
| Signatures are bound to one vault on one chain | `test_SignaturesForAnotherVaultAreRefused`, `test_SignaturesForAnotherChainAreRefused` |
| The checker's signature alone cannot pay | `test_TheCheckerSignatureAloneIsNotEnough` |
| Each invoice is paid once | `test_RefusesTheSameInvoiceTwice`; the gateway killed mid-run and restarted: 8 payments, 8 transactions (`services/gateway/results/2026-10-07-testnet.json`) |
| Several approvers: one cannot add a supplier alone when two are required; any one can pause or refuse | `test_WithTwoRequiredOneOwnerCannotAddASupplier`, `test_AnyOneOwnerCanPause`; on testnet [added by both](https://testnet.monadexplorer.com/tx/0x46ac7185cc6801c218702cdcfbc08d1162fb0c85ec436715a3188bc13ed338af), [paused by one](https://testnet.monadexplorer.com/tx/0xb04fbcbc1ff569dbe70ae74fa09996d37ba16724f7f73a774cc8bdcba5e4df2f), [paid once by both](https://testnet.monadexplorer.com/tx/0xb601ae0a054502641c9e43b4cb893da376e7d2daa5cf998465b86b70aff30acc) |

## Addresses are proven

| Claim | Proof |
| --- | --- |
| A supplier's own website proves its payment address (Primus zkTLS), recorded on Monad | `SupplierProofs` at [`0xA91F…aE57`](https://testnet.monadexplorer.com/address/0xA91FBA7133F24aadf77c28769C706f71E281aE57); the probe refused a changed file (`AddressDiffers`) at [`0xF469…6ca6`](https://testnet.monadexplorer.com/address/0xF469cEC069AEAa068238c50e70FE682a794E6ca6); `contracts/test/unit/SupplierProofs.t.sol` |

## The checker is a measured detector

| Claim | Proof |
| --- | --- |
| Code decides "clear"; the model can only hold; any error or timeout is a hold | "D27: every code failure stays held whatever the model says" and "holds when the model fails or runs out of time (fail closed)" in `services/checker/test/check.test.ts` |
| Every demo invoice checked with the real model | `services/checker/results/2026-10-08-demo-with-jev.json` |
| Each model question defines its yes and its no; on 35 invoices written to fool it, no disguise passed (1 before), 29 held outright (16 before), no honest invoice held outright (2 before) | `services/checker/results/2026-10-09-criteria-eval.json` (`pnpm --filter @countersign/checker criteria-eval`); `services/checker/test/criteria.test.ts`; live: `services/gateway/results/2026-10-09-criteria-live-after.json` |
| An agent with no model paid all 14 demo cases live; each ended as its document says | `services/gateway/results/2026-10-08-scripted-agent.json`, `…-scripted-agent-checker.json` |
| A real model, given only the MCP tools and a page reader, paid the clean invoice; the five doctored ones were held for the right reasons | `apps/agent-runner/results/2026-10-08T07-07-07-245Z.json` |
| Bank-transfer advice: "we have moved to a new bank" is a mismatch, a clean bank invoice a match | `services/gateway/results/2026-10-08-advice-live.json` (live, through the hosted MCP server); `services/checker/test/bank.test.ts`, `advise.test.ts` |

## At volume

| Claim | Proof |
| --- | --- |
| 200 invoices, every one ending as expected (170 paid, 30 doctored held or stopped, no clean one held), the last paid in under 20 s | [run board](https://gateway-production-e17a.up.railway.app/r/0xb417ea6ba652539443dd916d7c4c8697353693e790b86048df15beb6c2f4a55c); `services/gateway/results/2026-10-08-run-200-4.json` |
| 100 invoices, all as expected, the last final on Monad 5.0 s after intake | [run board](https://gateway-production-e17a.up.railway.app/r/0xf97adff5812306ee36d719a00b209a25b2b17e97559470878ac4cd9872105d4e); `services/gateway/results/2026-10-08-run-100.json` |
| A second agent sending the same invoices at once is paid once | the same files (`secondAgent`) |

## The benchmark (Slice 20)

The same 40 invoices (20 clean, 20 doctored), drafted once; `apps/agent-runner/results/benchmark-2026-10-08.json` has every invoice, every arm and every reason.

| Arm | Doctored caught | Clean wrongly held | USDC let go |
| --- | --- | --- | --- |
| No guard (computed) | 0 of 20 | 0 of 20 | 0.0199 |
| Limits only (computed: 0.005 a payment, 0.03 a day) | 9 of 20 | 5 of 20 | 0.0111 |
| Countersign (live, Monad testnet) | 20 of 20 | 0 of 20 | 0 |

The arm where the agent checks itself with a model is being rerun on the same saved set (`apps/agent-runner/src/benchmark/self-check-run.ts`).

## Every decision on the record

| Claim | Proof |
| --- | --- |
| A checker's hold and an owner's refusal are written on Monad with their evidence hash | the [hold](https://testnet.monadexplorer.com/tx/0x550fec1f0d1ea783a8ecf0834e9490300f552f1bce18290a186ebd1926dcb722) and the [refusal](https://testnet.monadexplorer.com/tx/0x90289bdf1bc7ce8cc42a814a3f1c88a565af7ec77e33c9c2e608fabea0cf3827) of one held invoice |
| A payment's record checks out against Monad without trusting us | `npx --package=https://github.com/AfshalG/countersign/releases/download/sdk-v0.3.0/countersign-sdk-0.3.0.tgz countersign-verify services/gateway/results/2026-10-08-record-ks-1003.json` |
| Every payment names its registered agent (ERC-8004) | agent 2066 [registered](https://testnet.monadexplorer.com/tx/0xfa658c16655c9e7504747eac094897969bf802c02294fa7e67e0ed3b7972aba8), its [wallet set](https://testnet.monadexplorer.com/tx/0xc55c9b450d147ebb62bb68fe333ecab69f614b6207dfe8bddbf586256c88b0da); `services/gateway/test/agents.test.ts` |

## Reproduce a run

```bash
pnpm install
cp .env.example .env    # a funded testnet deployer key, for the runs that pay
pnpm --filter @countersign/gateway run-200 --size 20          # a run, scored
pnpm --filter @countersign/gateway exec tsx scripts/record-smoke.ts   # a hold, a refusal, a verified record
pnpm --filter @countersign/agent-runner benchmark <model ...>  # the benchmark
```

Each run checks first that the relayers have gas for all of it (`/health`, `funds.paymentsLeft`).
