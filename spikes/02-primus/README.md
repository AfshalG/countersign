# Spike 2: a Primus proof that a supplier's own website lists its payment address

Throwaway code. Never imported by product code. Plan and full results: Slice 2 in the planning notes.

**Result (7 Oct 2026, UTC): it works.** The demo supplier publishes `{ "payTo": "0x90f9…5fEc" }` at
`https://countersign-supplier-demo.vercel.app/.well-known/countersign.json`. Primus attests it from our
server (proxy-TLS, WebAssembly build, about 4–5 s). The proof passes Primus's own verifier on Monad
mainnet (read-only) and our probe on Monad testnet; a proof of a changed file is refused.

| Measure                                  | Value                                                 |
| ---------------------------------------- | ----------------------------------------------------- |
| Time to get a Primus proof               | 4.2–4.9 s                                             |
| Probe check, gas (testnet transaction)   | 122,391 (whole transaction 193,173)                   |
| Sending to finalized                     | 1.19 s                                                |
| Primus's mainnet verifier `0xCE7c…afdE`  | Accepts the real proof; rejects one changed character |
| Supplier file changed to another address | Refused: `AddressDiffers` (`0xd0e828c9`)              |

Deployed on testnet (chain 10143): Primus verifier proxy `0x643C855Aaee9Fe8e37B5e3dE19e75A889d3218FE`
(trusts only Primus's attestor `0xDB73…8eF6`), probe `0xF469cEC069AEAa068238c50e70FE682a794E6ca6`.

## What we learned about Primus

- `data` is Primus's own JSON of the extracted value (`{"payTo":"…"}`), not the raw file; spacing and other fields do not matter. The value is verbatim, so the address must be published checksummed.
- `timestamp` is in milliseconds.
- **Primus's verifier checks only the signature.** It does not check the timestamp, although its comments say it does; the probe does.
- **Its hash packs strings with no separators**, so bytes can move between neighbouring fields without breaking the signature. The tests show a URL-into-header shift and a data-into-conditions shift that Primus's verifier accepts and the probe rejects. The probe pins every field.
- The `attestors` list in an attestation is not signed; only the verifier's own list counts.
- The SDK's native build is not needed (it falls back to WebAssembly), it uses `tslib` without declaring it, and it keeps connections open, so scripts exit explicitly.

## Run it

```bash
pnpm install
cd spikes/02-primus
forge soldeer install && forge test -vv   # 19 tests against the recorded proof
pnpm attest <label> [url]                 # get a new Primus proof (needs PRIMUS_APP_* in ../../.env)
pnpm fixtures                             # ABI-encode recorded proofs for Foundry
pnpm verify:mainnet <label>               # read-only check on Primus's Monad mainnet verifier
pnpm verify:testnet <label> [payTo]       # check with the testnet probe, read-only and in a transaction
```
