# Slice 2 (Spike): A Primus proof that a supplier's own website lists its payment address

## Status

**DONE (7 Oct 2026, UTC).** Approved by Afshal ("ok", S2-1 to S2-5). Built on `feature/spike-02-primus`, CI green. Owner: Afshal (contracts); Claude built it.

## Goal

Prove that Countersign can show, and check on Monad, that **the supplier's own website lists the payment address** the agent proposed. The proof comes from Primus zkTLS: Primus signs a statement that "this HTTPS response really came from this domain and contained this address", and a contract on Monad checks that signature.

This is what the approval sheet means by "the supplier's own website still lists the address on file". It catches the most common fraud in the plan: an invoice or a "new payment details" email that gives a fraudster's address. A fraudster can fake an invoice, but not the supplier's own website.

**What this spike decides**

| If it works | If it fails |
|---|---|
| Adding a supplier shows a proof that its website lists the address, checked on Monad. Slice 15 wires it into the account | The approver confirms the address by hand, and the sheet says "not verified by the supplier's website" |

## How it works, in one picture

```
Supplier's website (HTTPS)                      Countersign
https://supplier.example/.well-known/countersign.json
{ "payTo": "0x8f3a…4b1e" }
          │
          │  1. our server asks Primus to fetch it (proxy-TLS)
          ▼
   Primus attestor (key 0xDB73…8eF6)
          │  2. signs: this URL, this response field, this time
          ▼
   Attestation (JSON) ──► 3. our contract on Monad:
                            • signature is from Primus's attestor (Primus's own verifier code)
                            • URL is exactly the supplier's file
                            • the address in it is the one proposed
                            • it is recent
```

## Already known before writing code (6 Oct)

- **Primus runs its own verifier on Monad mainnet** at `0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE`, owned by its attestor address `0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6`. There is **none on testnet** (checked: no code at that address on 10143).
- **Its check is a free read-only call** (`verifyAttestation` is `view`), so any proof we make can also be checked against Primus's production verifier on Monad mainnet, without a mainnet transaction.
- Primus's deployment records list 12 chains, none of them Monad testnet. We deploy its open-source verifier ourselves on testnet with the same attestor.
- **SDK:** `@primuslabs/zktls-core-sdk` 0.3.7 (updated 27 Jul 2026). Depends on `ethers` 5, `ws`, `uuid` and **`node-addon-api`, a native component**: it may need building on install, and Node 24 support is unconfirmed. The first step checks this.
- **Keys:** the SDK needs an app ID and secret from the **Primus Developer Hub**. Afshal has to sign up for those.

## Prerequisites

- Slices 0 and 1 done. ✅
- **Primus app ID and secret** from https://dev.primuslabs.xyz (Afshal signs in; the values go into `.env` as `PRIMUS_APP_ID` and `PRIMUS_APP_SECRET`, already listed in `.env.example`). Also check the free proof quota there.
- The testnet wallet from Slice 1 (4.9 MON left is plenty).

## Cross-checked (6 Oct 2026)

| Source | What was checked |
|---|---|
| Context7 `/websites/primuslabs_xyz` | Core SDK flow: `new PrimusCoreTLS()`, `init(appId, appSecret)`, `generateRequestParams(request, responseResolves[{keyName, parsePath}])`, `setAttMode({ algorithmType: "proxytls" })` (the default), `startAttestation`, `verifyAttestation`. Attestation fields: `recipient`, `request{url,header,method,body}`, `reponseResolve` (Primus's spelling), `data` (stringified JSON), `attConditions`, `timestamp`, `additionParams`, `attestors[{attestorAddr,url}]`, `signatures` |
| `primus-labs/zktls-contracts` at `3082c53` (11 Jun 2026) | `IPrimusZKTLS.verifyAttestation(Attestation) external view`; it requires exactly one 65-byte signature, recovers the signer with `ecrecover` over `encodeAttestation(...)` and checks it against the owner's attestor list. Deployed behind an upgradeable proxy with `initialize(owner, attestors)` |
| Monad mainnet, read-only calls | Verifier `0xCE7c…afdE` has code; `owner()` returns `0xDB73…8eF6` |
| npm | `@primuslabs/zktls-core-sdk` 0.3.7 and its dependencies |
| Earlier design notes (26–27 Sep) | Proxy-TLS sees only what the server sends: no JavaScript-rendered content, no redirects. Attestations take about 0.65 s and are cached per supplier |

Not yet confirmed (the spike answers these): the exact format of `data`, the unit of `timestamp`, `verifyAttestation` gas on Monad, whether the SDK installs on Node 24, and the free quota.

## Design considerations

**1. What the supplier publishes.** A static file at `https://<supplier domain>/.well-known/countersign.json`, for example `{ "payTo": "0x…" }`. A fixed path on the supplier's own domain is the same pattern as other `.well-known` files: easy for any supplier, impossible to fake without control of the domain. It must be plain JSON served directly, with no redirects or scripts, because Primus attests the raw HTTPS response.

**2. Which verifier the contract trusts.** We deploy Primus's own `PrimusZKTLS` code (pinned commit) on testnet, initialised with Primus's attestor address. So the testnet contract trusts exactly what Primus's mainnet verifier trusts. As an independent cross-check, the same attestation is sent to Primus's mainnet verifier with a read-only call.

**3. What our contract checks on top of Primus's signature.** Primus only proves "this response came from this URL". Our probe adds the business rule:
- the URL is **exactly** the expected supplier file (string equality, no prefix tricks such as `supplier.example.attacker.com`);
- the attested address is **exactly** the proposed one (compared by code);
- the proof is **recent** (a maximum age, set in the contract);
- the request is a `GET` with no body.

**4. Trust, stated plainly.** zkTLS shifts trust; it doesn't remove it. We trust Primus's attestor key and normal HTTPS. If the supplier's website itself is hacked, the proof faithfully shows the hacked address. The approval sheet says "listed on the supplier's website", never "safe".

**5. Our own demo supplier.** For the spike and the demo, a small static site on Vercel serves the `.well-known` file for "Kalibre Studio". It becomes the supplier portal in Slice 7.

**6. Spike code lives in `spikes/02-primus/`** and is never imported by product code. The verifier source comes from Primus's repo at a pinned commit, not copied by hand.

## What gets built

```
spikes/02-primus/
├── README.md                         how to run; results filled in at the end
├── supplier-site/public/.well-known/countersign.json    the demo supplier's file (Vercel, static)
├── foundry.toml                      same compiler settings; Primus contracts at a pinned commit
├── src/SupplierProofProbe.sol        checks URL, address, age, method, then Primus's verifyAttestation
├── script/DeployPrimus.s.sol         deploys PrimusZKTLS behind its proxy with Primus's attestor
├── script/DeployProbe.s.sol
├── test/SupplierProofProbe.t.sol     tests against recorded attestations
├── test/fixtures/*.json              the real attestation, plus doctored copies
├── ts/attest.ts                      Primus core SDK: fetch and attest the supplier file, save it
├── ts/encode.ts                      SDK attestation JSON → the Solidity struct (viem types)
├── ts/encode.test.ts
└── ts/verify-onchain.ts              testnet probe + read-only check on Primus's mainnet verifier
```

## Tests first

**Vitest** (`ts/encode.test.ts`), seen failing first:
1. A recorded attestation maps to the Solidity struct field for field, including Primus's `reponseResolve` spelling.
2. `timestamp` is converted with the right unit (confirmed from the first real attestation).
3. A malformed attestation (missing signature, two signatures) is refused before any gas is spent.

**Foundry** (`test/SupplierProofProbe.t.sol`), against the recorded real attestation:
1. The real attestation passes.
2. Wrong address: fails.
3. Wrong URL, including a look-alike domain and a different path: fails.
4. Too old: fails.
5. One changed character in `data`: Primus's signature check fails.
6. Signed by a key that isn't Primus's attestor: fails.
7. A `POST` request, or a request with a body: fails.
8. Fuzz: random addresses never pass against the recorded proof.

## Git workflow

```bash
git checkout development && git pull
git checkout -b feature/spike-02-primus
# commits, each with its tests, merged only after CI passes:
#   feat: demo supplier site with its .well-known address file
#   feat: attest the supplier file with Primus and record it
#   feat: encode Primus attestations for Solidity
#   feat: supplier proof probe on top of Primus's verifier
#   feat: deploy Primus's verifier and the probe to testnet
#   docs: spike results
```

## Manual testing (the actual spike)

1. Install the SDK on Node 24. Expected: it installs; if its native part needs building, allow it in `pnpm-workspace.yaml`.
2. Deploy the demo supplier site. `curl` the file: plain JSON, no redirect.
3. `ts/attest.ts`: an attestation comes back, signed by `0xDB73…8eF6`. Note how long it took.
4. `forge test`: all pass against the recorded attestation.
5. Deploy `PrimusZKTLS` and the probe to testnet; check the real attestation in a transaction. Note gas and time to finalized.
6. Read-only call of the same attestation on **Primus's Monad mainnet verifier**. Expected: passes.
7. Change the supplier file to a different address, attest again, and check it against the original proposed address. Expected: fails with "address differs".

## Results (7 Oct 2026, UTC)

| Measure | Value |
|---|---|
| SDK installs on Node 24 | Yes, in WebAssembly mode; the native build is not needed and is turned off |
| Time to get an attestation | 4.2–4.9 s |
| Probe check gas, testnet transaction | 122,391 (whole transaction 193,173); about 123k locally |
| Sending to finalized | 1.19 s |
| Passes Primus's own mainnet verifier | Yes (read-only); a copy with one changed character is rejected |
| Supplier file changed to another address | Refused on testnet: `AddressDiffers` |
| Free proof quota | Not found in the docs or the Hub |

Deployed (chain 10143): Primus verifier proxy `0x643C855Aaee9Fe8e37B5e3dE19e75A889d3218FE` (logic `0xD143…e70a`, trusts only `0xDB73…8eF6`), probe `0xF469cEC069AEAa068238c50e70FE682a794E6ca6`. Demo supplier: `countersign-supplier-demo.vercel.app`, address `0x90f9931B748B26763161a8191C178Fe425C25fEc`.

## Verdict

**The spike works.** Adding a supplier can show a proof that its own website lists the address, checked on Monad. Slice 15 wires the probe's checks into the account.

## Findings about Primus (carry into Slices 5, 10 and 15)

1. **Its verifier checks only the signature.** It does not check the timestamp, although its comments say it does. Every business rule is ours.
2. **Its hash packs strings with no separators**, so bytes can move between neighbouring fields without breaking the signature. Shown with Primus's real signature: a URL-into-header shift and a data-into-conditions shift both pass Primus's verifier. The probe pins every field (URL, method, header, body, key, parse path, conditions, extra parameters, data), which rejects both.
3. **The `attestors` list inside an attestation is not signed.** Only the verifier's own list counts.
4. `data` is Primus's JSON of the extracted value (`{"payTo":"…"}`), not the raw file; the value is verbatim. Suppliers must publish the checksummed address, or the check must compare case-insensitively (decide in Slice 15).
5. `timestamp` is in milliseconds.
6. Its `initialize` is not locked on the bare contract, so it must be deployed behind its proxy and initialised in the same transaction.
7. Its signatures use plain `ecrecover`, so they are malleable; never use a signature as an identifier.

## Adapted from spec

1. **Native build skipped** (`allowBuilds: false`): the SDK falls back to the WebAssembly build it ships. No vendor build code runs on our machines or servers.
2. **`tslib` declared** for the SDK through `packageExtensions`; the SDK uses it without declaring it.
3. **Scripts exit explicitly** with a time limit; the SDK keeps connections open.
4. **Field pinning wider than planned:** the plan pinned URL, method and body; the probe also pins header, key, parse path, conditions and extra parameters, because of finding 2.
5. **Fixtures are ABI-encoded by TypeScript** and decoded in Foundry, instead of JSON parsing in Solidity.
6. **Two shift tests expected a different error** than the probe raised; the pinned neighbouring field caught each first. Tests corrected to the stricter outcome.
7. **CI:** Soldeer installs Primus's contracts from GitHub at commit `3082c53`; ESLint and Prettier skip downloaded libraries.
8. Primus's public repo contains a block-explorer API key in its own config. It is theirs and already public; it is not in our repo.

## Commit

The commits above, merged into `development` with `--no-ff`, only after CI passes.

## Next

Slice 3: 200 payments, order vaults against one account, several agents at once, and the private RPC endpoint.

## Decisions for Afshal in this slice

| # | Decision | Recommendation |
|---|---|---|
| S2-1 | Where the supplier publishes its address | `/.well-known/countersign.json` on its own domain, plain JSON |
| S2-2 | Which verifier the contract trusts | Primus's own verifier code, deployed by us on testnet with Primus's attestor; cross-checked against Primus's mainnet verifier |
| S2-3 | What the sheet promises | "Listed on the supplier's website", never "safe"; trust in Primus and HTTPS stated in the limits |
| S2-4 | Maximum proof age | 24 hours for the spike; set per supplier later |
| S2-5 | Primus keys | You sign up at the Primus Developer Hub; the keys go only in `.env` |

---

