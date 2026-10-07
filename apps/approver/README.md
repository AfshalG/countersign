# Approver app (`apps/approver`)

The phone app where the owner decides: approve a held payment once or refuse it, approve a proposed supplier and order, pause the account. Phone first; installs as a PWA. Owner: Sophie.

```bash
pnpm install                      # from the repo root
pnpm --filter @countersign/approver dev
```

**What is already here**

- Next.js 16 with the build settings our workspace packages need: webpack (`--webpack`) and `resolve.extensionAlias` in `next.config.ts`. Turbopack cannot resolve the packages' `.js` imports to their `.ts` sources.
- `@countersign/shared`: EIP-712 types (`vaultDomain`, `paymentTypes`, `decisionTypes`, `accountDomain`, `ownerActionTypes`), typed statuses and reasons, `REASON_TEXT` (plain wording for each reason), `formatUsdc`. These match the deployed contracts; never redefine them.
- `ox` 1.8.5, as in the passkey spike (`spikes/01-passkey`): `WebAuthn` signs a challenge with the phone's passkey.

**The API**

- Reference: https://gateway-production-e17a.up.railway.app/docs (generated from the gateway's code).
- **What to build, feature by feature, with sample approvals: [`FEATURES.md`](FEATURES.md).** Kept in step with the code; check its "What changed" first.
- The owner's routes: `GET /v1/approvals/{id}` returns the summary, `differences[]` and the exact challenge to sign for each action, and `POST /v1/approvals/{id}` takes the assertion as the browser gives it; the gateway works out the indexes and low-s. Live on testnet.
- The other `/v1` routes need the gateway's service token: never ship it to the browser. Call them from this app's server (route handlers, `GATEWAY_TOKEN` from the environment). The approvals routes need no token: the owner's passkey authorizes them.

**What the passkey signs**

The EIP-712 digest of the action, as the WebAuthn challenge, with user verification (Face ID, fingerprint or PIN). A held payment: the vault's `Payment` digest (`vaultDomain(10143, vault)`, `paymentTypes`). The contract computes the same digest and checks it through the P256 precompile.
