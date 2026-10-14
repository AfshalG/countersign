# Agentkey ↔ Countersign (Track 04 bridge)

**Agentkey = who.** **Countersign = may this agent pay.**

Same Monad Metropolis Track 04 story, two repos (not a monorepo merge):

| Repo | Role |
| --- | --- |
| [Agentkey](https://github.com/Rosh2403/AgentKey) | Portable agent identity: issue / resolve / **verify** (fail closed) |
| [Countersign](https://github.com/Rosh2403/countersign) | Payment account on Monad: ERC-8004 agent wallets sign payments inside owner rules |

Countersign already ties each payment to an ERC-8004 `agentWallet`. This bridge optionally asks Agentkey “is this agent still who they claim?” **before** the gateway accepts a payment.

## What is wired

- Package `@countersign/agentkey-bridge` — maps ERC-8004 agent id ↔ Agentkey id, calls `@agentkey/sdk` `verify`
- Gateway choke point: `POST /v1/payments` and `POST /v1/runs` (MCP / SDK pay tools go through the gateway)
- Behind env flags (default **off** so existing testnet demos keep working)

Verify is **fail closed**: only Agentkey `status: "valid"` authorizes. Transport errors, `invalid`, `unknown`, `revoked`, and `error` all return **403** — never soft-allow.

## Env vars

| Variable | Required when enabled | Meaning |
| --- | --- | --- |
| `AGENTKEY_VERIFY_ENABLED` | — | `true` / `1` / `yes` / `on` to turn the gate on |
| `AGENTKEY_BASE_URL` | yes | Agentkey HTTP API base (no trailing slash needed), e.g. `http://127.0.0.1:8787` |
| `AGENTKEY_BINDINGS` | recommended | JSON map `{"2066":"ak_hosted",…}` ERC-8004 id → Agentkey id |
| `AGENTKEY_ACCESS_TOKEN` | no | Optional bearer for Agentkey private resolve |

Names only in `.env.example`. Never commit secrets.

## Dependency (no npm publish)

```json
"@agentkey/sdk": "github:Rosh2403/AgentKey#main&path:packages/sdk"
```


## Demo steps (flagged verify path)

1. **Run Agentkey API** (from the Agentkey repo):

   ```bash
   pnpm install && pnpm build
   pnpm --filter @agentkey/api dev   # :8787
   ```

2. **Issue an agent and make a proof** (Agentkey quickstart or SDK):

   ```ts
   import { AgentkeyClient, agentKeys } from '@agentkey/sdk';
   const client = new AgentkeyClient({ baseUrl: 'http://127.0.0.1:8787' });
   const keys = agentKeys.generate();
   const agent = await client.issue({ publicHandle: 'cs-demo', publicKey: keys.publicKey });
   const proof = agentKeys.createProof({
     agentId: agent.id,
     challenge: 'countersign-pay',
     privateKey: keys.privateKey,
   });
   // save agent.id + proof
   ```

3. **Start Countersign gateway** with the gate on, binding your ERC-8004 agent (e.g. hosted `2066`) to that Agentkey id:

   ```bash
   export AGENTKEY_VERIFY_ENABLED=true
   export AGENTKEY_BASE_URL=http://127.0.0.1:8787
   export AGENTKEY_BINDINGS='{"2066":"ak_…"}'   # your issued id
   # …plus the usual gateway env (DATABASE_URL, RELAYER_PRIVATE_KEYS, …)
   pnpm --filter @countersign/gateway dev
   ```

4. **Pay with an Agentkey proof** on the submission (in addition to the usual EIP-712 `agentSig`):

   ```json
   {
     "account": "0x…",
     "vault": "0x…",
     "payment": { "amount": "1000", "invoiceHash": "0x…", "payTo": "0x…", "deadline": 1791400000 },
     "agentSig": "0x…",
     "agentkey": { "proof": "{\"challenge\":\"countersign-pay\",\"signature\":\"…\"}" }
   }
   ```

   Or pass `"agentkey": { "id": "ak_…", "proof": "…" }` if you skip `AGENTKEY_BINDINGS`.

5. **Fail-closed check**: stop the Agentkey API (or send a bad proof). The same `POST /v1/payments` returns **403** with `error: "agentkey_verify_failed"` and `status: "error"` (or `invalid`) — payment is not created.

With the flag **off**, behaviour is unchanged: no Agentkey call, demos work as before.

## MCP

MCP `pay_invoice` / `pay_invoices` hit the same gateway routes. When the gate is on, the client must include `agentkey` on the payment body the SDK/gateway accepts (extend the tool input or pass proof via your agent’s pay path). The contract security model is unchanged: vaults still enforce suppliers, caps, and checker/owner signatures.
