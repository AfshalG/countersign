# Slice 1 (Spike): A passkey signature verified on Monad testnet

## Status

**DONE (6 Oct 2026). iPhone, Android and Mac all pass on Monad testnet.** Approved and revised phone-first the same day. Afshal: most day-to-day payment approvals happen on phones, iPhone and Android, so a phone is the pass condition and the laptop is secondary. Owner: Afshal (contracts).

## Goal

Prove, with a real transaction on Monad testnet, that a signature made by a real passkey **on a phone** (Face ID on an iPhone, fingerprint or face unlock on Android) is accepted by an OpenZeppelin `WebAuthn.verify` check, and that the check runs through Monad's P256 precompile at `0x0100`, not the slow fallback. Record the gas.

This is the base of the whole product: the owner of every Countersign account is a passkey, and every hold is released with Face ID. If this fails, the owner check falls back to OpenZeppelin's pure-Solidity verifier, which works but costs much more gas.

**What this spike decides**

| If it works | If it fails |
|---|---|
| The owner is a passkey, checked through the precompile. Slices 5 and 9 build on `WebAuthn.verify` | OpenZeppelin's Solidity fallback (`P256.verifySolidity`), with its measured gas cost in the plan |

## Already known before writing any code (6 Oct, read-only calls)

- `eth_chainId` on `https://testnet-rpc.monad.xyz` returns `0x279f` (10143).
- **The precompile exists and works on testnet.** An `eth_call` to `0x0100` with OpenZeppelin's built-in known-good test vector (the one it uses to detect the precompile) returns `1`.
- The testnet USDC address in CLAUDE.md (`0x534b…43A3`) has code. Monad's testnet was reset from genesis on 16 Dec 2025, so this was worth checking.

So the open questions are narrower: does a **fresh signature from a real passkey**, encoded the way viem and ox produce it, pass OpenZeppelin's full WebAuthn checks in a **real transaction**, and what does it cost?

## Prerequisites

- Slice 0 done. ✅
- **A funded testnet deployer wallet.** I generate a fresh, testnet-only key with `cast wallet new` into the repo's `.env` (never committed) and give Afshal the address. Funding it needs `https://faucet.monad.xyz`, which may ask for a sign-in; Afshal does that step, or I try it through the browser.
- **An iPhone and an Android phone** for the real-passkey step (Android: Roshan or Sophie if Afshal has none), plus a Mac with Touch ID as the laptop case.
- **HTTPS hosting.** Browsers allow passkeys only on HTTPS (or `localhost`), so the test page and a small send endpoint go on Vercel. Afshal logs the Vercel CLI in once.
- **Testnet deployer wallet:** generated 6 Oct, `0xf8a69BdB48aeae88136C7F9D87FeB2B24458C79B`, key only in the repo's ignored `.env`. Afshal funds it from the faucet.

## Cross-checked (6 Oct 2026)

| Source | What was checked |
|---|---|
| OpenZeppelin 5.7.0 source (`P256.sol`, `WebAuthn.sol`, installed in Slice 0) | `WebAuthn.verify(challenge, auth, qx, qy, requireUV)`; the `WebAuthnAuth` struct (`r`, `s`, `challengeIndex`, `typeIndex`, `authenticatorData`, `clientDataJSON`). **`P256.verify` silently falls back to Solidity when the precompile is missing**; `verifyNative` reverts instead. **Signatures with `s` above N/2 are rejected.** It does not check origin, RP ID or the signature counter |
| Monad docs, Precompiles page | `0x0100` is P256 verification per EIP-7951 (same address and interface as RIP-7212). **Gas: 6,900.** Monad supports every Ethereum precompile up to the Fusaka fork |
| Monad docs, Testnet page | Chain 10143; faucet `https://faucet.monad.xyz`; explorers MonadVision (`testnet.monadvision.com`) and Monadscan. Testnet reset 16 Dec 2025 |
| Monad docs, Opcode Pricing (through Context7) | Not for this slice, but important for Slices 3 and 5: contract creation costs 160,000 gas plus 1,200 per deployed byte, and a new storage slot costs 127,900. Recheck on the page in Slice 3 |
| Context7 `/wevm/ox` and the ox 1.8.5 source | `WebAuthnP256.createCredential`, `sign` (returns `metadata` with `authenticatorData`, `clientDataJSON`, `challengeIndex`, `typeIndex`, and `signature` `{r, s}`), `getSignPayload`, `verify`; `P256.randomPrivateKey`, `getPublicKey`, `sign`. **ox already flips high-s browser signatures to low-s** (`parseAsn1Signature`), which OpenZeppelin needs |
| npm | ox 1.8.5, viem 2.57.3 |

**Correction to Slice 0:** the testnet explorer used in Slice 0's notes (`testnet.monadexplorer.com`, from Monad's MetaMask guide) is outdated; the Testnet page lists MonadVision and Monadscan.

## Design considerations

**1. Spike code lives in `spikes/01-passkey/` and is never imported by product code** (CLAUDE.md). It has its own small Foundry project and TypeScript scripts. What we learn moves into `contracts/` in Slice 5 and the app in Slices 9 and 11.

**2. Prove the precompile was used, not just that verification passed.** Because `P256.verify` falls back silently, a passing transaction alone doesn't prove anything about Monad. The probe contract has three entry points:
- `verify`: OpenZeppelin's normal `WebAuthn.verify` (what the product will use).
- `verifyNative`: the same checks, but the signature step uses `P256.verifyNative`, which **reverts if the precompile is missing**.
- `verifySolidity`: forces the pure-Solidity path, for the gas comparison.

The gas gap between `verifyNative` and `verifySolidity` in a real transaction is the evidence.

**3. Require user verification (Face ID, Touch ID or PIN).** `WebAuthn.verify` can skip the "user verified" flag. We require it: a hold is released by the person, not by whoever holds the phone unlocked.

**4. Two kinds of signature, one code path for every device.** Passkeys are a web standard (WebAuthn): the browser shows whatever unlocks the device (Face ID, fingerprint, Windows Hello, Touch ID), and the contract checks every one the same way. No App Store, no Gatekeeper: it is a web page.
- **Software-signed (deterministic):** a script makes a P-256 key with ox, builds the WebAuthn payload a browser would build, and signs it. Used for the Foundry tests and for the first testnet transactions. Repeatable, no person needed.
- **Real passkey:** one mobile-first web page on Vercel (HTTPS) creates a passkey with the device's screen lock and signs a challenge. It checks the signature against the testnet contract with a read-only call straight from the phone, then sends it to a small Vercel endpoint that submits the real transaction with the testnet key and returns the explorer link. Phones need no wallet and no MON. This is the real proof.

**5. The challenge.** In the product, the challenge is the EIP-712 digest of the payment. Here it is any 32 bytes; the contract checks the signature is over exactly that challenge.

**5b. One deployment for every device.** The probe takes the public key as an argument (`verify(challenge, auth, qx, qy)`) instead of storing one key, so a single testnet deployment serves the iPhone, the Android phone and the Mac.

**6. Real transactions, not just `eth_call`.** `record(...)` changes state (it increments a counter and emits `Verified(bool ok, uint256 gasUsed)`), so the result sits in a block. We wait for **finalized**, per CLAUDE.md money rule 4, and record how long that took.

## What gets built

```
spikes/01-passkey/
├── README.md                  how to run it; results table filled in at the end
├── foundry.toml               same compiler settings as contracts/ (solc 0.8.37, via_ir)
├── src/PasskeyProbe.sol       verify, verifyNative, verifySolidity (view, key as argument); record (tx)
├── test/PasskeyProbe.t.sol    tests against fixtures generated by the script below
├── test/fixtures/*.json       software-signed vectors
├── script/Deploy.s.sol        forge script to deploy the probe
├── ts/make-fixtures.ts        ox: key, WebAuthn payload, signature → fixtures
├── ts/send.ts                 viem: send record(...) on testnet, wait for finalized, print gas and explorer link
├── web/index.html             mobile-first page: create passkey (screen lock), sign, read-only check, send
└── web/api/record.ts          Vercel function: submits record(...) with the testnet key, waits for finalized
```

`ts/encode.ts` holds the one piece of real logic, `toWebAuthnAuth(metadata, signature)`: it maps ox's output to OpenZeppelin's struct and **refuses a high-s signature** rather than passing it on.

## Tests first

**Vitest** (`ts/encode.test.ts`), seen failing first:
1. `toWebAuthnAuth` maps ox's `metadata` and `signature` to the six struct fields in the right order and types.
2. It throws on a signature whose `s` is above N/2.
3. Round trip: a software-signed payload passes `WebAuthnP256.verify` in ox (proves our payload building matches the browser format before Solidity sees it).

**Foundry** (`test/PasskeyProbe.t.sol`), against the fixtures:
1. A valid signature passes `verify` and `verifyNative`.
2. A wrong challenge fails.
3. `clientDataJSON` with `"type":"webauthn.create"` instead of `webauthn.get` fails.
4. The user-verified flag cleared fails (we require it).
5. A high-s version of a valid signature fails.
6. A different public key fails.
7. Fuzz: a random challenge with a fixed valid signature fails.
8. Gas: `verifyNative` and `verifySolidity` are both recorded (`forge snapshot`); the test fails if native is not cheaper.

If Foundry's local EVM doesn't provide `0x0100`, test 1's `verifyNative` reverts; then we set `evm_version = "osaka"` and record it under "Adapted from spec".

## Git workflow

```bash
git checkout development && git pull
git checkout -b feature/spike-01-passkey
# commits:
#   test: passkey probe tests and software-signed fixtures
#   feat: passkey probe contract (verify, native, solidity)
#   feat: encode ox WebAuthn output for OpenZeppelin, refuse high-s
#   feat: testnet deploy and send scripts
#   feat: local passkey page (Touch ID)
#   docs: spike results
```

Tests are committed together with the code that makes them pass. CI runs the spike's Foundry tests too. No AI co-author lines.

## Manual testing (the actual spike)

1. Generate the deployer key; Afshal funds it from the faucet. Expected: balance above 0 on MonadVision.
2. `forge test` in `spikes/01-passkey`: all pass; note native and Solidity gas.
3. Deploy `PasskeyProbe` to testnet with the software key's public key. Expected: contract on MonadVision.
4. `ts/send.ts` with a software-signed vector: `record` succeeds, `Verified(true, …)`. Note gas used and the time from sending to finalized.
5. The same call through `verifySolidity`: succeeds; note gas. Native should be far cheaper.
6. **iPhone:** open the Vercel URL in Safari, create a passkey with Face ID, sign. The read-only check says valid; send. Expected: `Verified(true, …)` in a finalized block. **Pass condition.**
7. **Android:** the same in Chrome with fingerprint or face unlock. **Pass condition.**
8. **Mac:** the same with Touch ID (laptop case).
9. The page's "tamper" button sends a signature with one byte of the challenge changed. Expected: `Verified(false, …)`, never `true`.

## Results (6 Oct 2026, Monad testnet)

Probe `0xa0b9d0408af2fd0d2b164fdd97757dc6029b7e97`, deployed for 1,478,657 gas. Page: https://countersign-passkey-spike.vercel.app

| Measure | Value |
|---|---|
| Full check (`WebAuthn.verify`, UV required), software key | Accepted; 13,693 gas for the check, 67,753 for the transaction |
| Signature step through the precompile only | Accepted; 9,002 gas (transaction 61,644) |
| Signature step in pure Solidity only | Accepted; 357,431 gas (transaction 484,492). **The precompile is about 40× cheaper** |
| Tampered challenge | Rejected; 4,757 gas, recorded in a finalized block |
| Time from sending to finalized | 1.0 to 1.4 s (in a block after 0.3 to 0.8 s) |
| **Mac (Touch ID), real passkey** | ✅ Accepted, 13,659 gas: `0xcbb1d79c…`. Tampered: rejected, `0xfeaa1e1e…` |
| **Android (screen lock), real passkey** | ✅ Accepted, 13,659 gas: `0xbed9bc12…`. Tampered: rejected, `0xbc0b482c…` |
| **iPhone (Face ID), real passkey** | ✅ Accepted, 13,659 gas: `0x78e15bbd…`. No tampered run from the iPhone; the same check rejected tampering on the Mac, Android and the software key |

**Correction for later slices:** the deploy cost (1.48M gas for about 5 KB of code) does not fit the "1,200 gas per byte, 160,000 per creation" figures quoted from Context7 above, which would give roughly 6M. Those figures look outdated. Spike 3 measures vault creation directly.

## Verdict

**The spike works.** The owner of a Countersign account is a passkey, checked through Monad's P256 precompile with user verification required. Slices 5 and 9 build on `WebAuthn.verify` (decision S1-5's three-way probe proved the precompile path). The Solidity fallback is not needed.

## Adapted from spec

1. **ox renamed `WebAuthnP256` to `WebAuthn`** and returns `r`, `s` and public-key coordinates as hex, not numbers as its docs show. The encoder takes ox's `Signature<false>` type.
2. **pnpm 12 blocks install scripts unless allowed:** `allowBuilds: { esbuild: true }` in `pnpm-workspace.yaml` (tsx needs it).
3. **The probe's narrower checks** (`verifyNative`, `verifySolidity`) check the signature step only, because OpenZeppelin's flag and challenge checks are private. The full product check is `verify`.
4. **CI:** the spike's Foundry tests run as their own job, so the check names protecting `main` never change.
5. **Foundry's local EVM already has `0x0100`**; no `evm_version` change was needed.
6. **The deploy wallet** (`0xf8a6…C79B`, funded with 5 testnet MON) also pays for the page's transactions through the Vercel endpoint; its key is an encrypted Vercel setting.

## Commit

The commits above, merged into `development` with `--no-ff` once CI is green.

## Next

Slice 2: a Primus proof of a supplier's address file, on testnet.

## Notes for later slices

- **Slice 5 and Spike 3 (cost of one vault per order):** at Monad's prices, creating a contract costs 160,000 gas plus 1,200 per byte, and each new storage slot 127,900. A minimal clone is 45 bytes, so a vault costs roughly 214,000 gas before its own storage is written. Fees are charged on the gas limit, not gas used. Spike 3 should measure the real cost per order, because it bears on D13.
- **Slices 9 and 11:** a passkey is bound to the site's domain. Passkeys made on the spike's Vercel URL won't work on the real app's domain, so the app domain should be fixed early.

## Decisions for Afshal in this slice

| # | Decision | Recommendation |
|---|---|---|
| S1-1 | Where spike code lives | `spikes/01-passkey/`, never imported by product code |
| S1-2 | User verification | Required: Face ID, Touch ID or PIN, not just presence |
| S1-3 | Deployer wallet | A fresh testnet-only key I generate into `.env`; you fund it from the faucet |
| S1-4 | Real-passkey test | **Phones first:** iPhone and Android are the pass condition, the Mac is secondary. Page on Vercel for HTTPS. (Revised after Afshal's review) |
| S1-5 | Precompile proof | Three entry points (normal, native-only, Solidity-only), comparing real-transaction gas, as above |

---

