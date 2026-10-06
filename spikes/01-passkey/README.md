# Spike 1: a passkey signature verified on Monad testnet

Throwaway code. Never imported by product code. Plan and full results: Slice 1 in the planning notes.

**Result (6 Oct 2026): it works.** Real passkeys from an iPhone (Face ID), an Android phone (screen lock) and a Mac (Touch ID) were accepted by OpenZeppelin's `WebAuthn.verify` on Monad testnet, through the P256 precompile at `0x0100`. Tampered approvals were rejected.

| Check | Gas for the check | Transaction |
|---|---|---|
| Full check (user verification required) | 13,659 to 13,693 | about 67,700 |
| Signature step, precompile only | 9,002 | 61,644 |
| Signature step, pure Solidity | 357,431 | 484,492 |
| Tampered approval (rejected) | 4,757 | 56,511 |

Time from sending to finalized: 1.0 to 1.4 s.

- Probe: `0xa0b9d0408af2fd0d2b164fdd97757dc6029b7e97` (chain 10143)
- Test page: https://countersign-passkey-spike.vercel.app

## Run it

```bash
pnpm install
cd spikes/01-passkey
forge soldeer install && forge test -vv   # contract tests against software-signed fixtures
pnpm fixtures                              # regenerate fixtures (deterministic)
pnpm send full                             # record a software-signed check on testnet (needs ../../.env)
pnpm send full tamper                      # the same with a changed challenge: rejected
pnpm dev                                   # the test page on http://localhost:5173
```
