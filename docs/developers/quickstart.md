# Developer quickstart

Countersign gives an AI agent an account that pays only what its owner approved. You can reach it three ways; all three go to the same gateway and the same contracts on Monad testnet.

| | Use it when | Agent key |
|---|---|---|
| **SDK** (`@countersign/sdk`) | Your agent runs your TypeScript | Yours: it signs in your process |
| **MCP server** | Your agent speaks MCP (Claude Code today) | Held by the server for the account (hosted mode) |
| **Web API** | Anything else | Yours: sign the payment as the SDK does |

## 1. Get a test account (one command)

```bash
npx --package=https://github.com/AfshalG/countersign/releases/download/sdk-v0.2.0/countersign-sdk-0.2.0.tgz countersign-test-account > .env
```

In about ten seconds, with nobody from us involved, you have your own account on Monad testnet:

- an **agent key** (`COUNTERSIGN_AGENT_KEY`), made on your machine; the account's policy names it, and it never leaves your process;
- the **account** (`COUNTERSIGN_ACCOUNT`) with 0.01 test USDC, the demo supplier Kalibre Studio at the address its website lists, and a 0.005 USDC order;
- a **token** (`COUNTERSIGN_TOKEN`, `cs_…`) that reaches only this account;
- an **owner key** (`COUNTERSIGN_OWNER_KEY`), a P-256 key standing in for the owner's passkey: it signed the account's setup, and it decides holds with `decide()`. A real account's owner signs with Face ID instead; a test account is for testing only.

The same from code: `createTestAccount()` from `@countersign/sdk/test-account` (Node). Test accounts share judge mode's daily limit (30 a day). The MCP server below still pays from a shared demo account: ask us for its token.

## 2a. The SDK

```bash
npm i https://github.com/AfshalG/countersign/releases/download/sdk-v0.2.0/countersign-sdk-0.2.0.tgz
```

[`examples/pay-an-invoice`](../../examples/pay-an-invoice) is a complete script: `npm run account` makes your test account, and `npm start` reads Kalibre Studio's clean invoice from the supplier's own page and pays it (0.001 USDC), waiting until it is settled at Monad's Finalized stage. Pass the invoice itself (`document: { html }` or `{ text }`): the checker reads it, and a payment with nothing to read waits for the owner.

A hold is decided by the owner. On a test account, with the owner key:

```ts
import { decide } from '@countersign/sdk/test-account';
await decide({ id: result.id, action: 'refuse', ownerKey: process.env.COUNTERSIGN_OWNER_KEY });
```

## 2b. The MCP server

```bash
claude mcp add --transport http countersign https://countersign-mcp.vercel.app/api/mcp \
  --header "Authorization: Bearer $COUNTERSIGN_MCP_TOKEN"
```

Then ask the agent to pay an invoice. It gets six tools: `list_open_orders`, `check_invoice`, `pay_invoice`, `pay_invoices`, `payment_status`, `propose_order`. Every result is text the agent can relay, plus structured data. A hold says why and gives the owner's link; the agent is told not to retry around it.

## 2c. The web API

The reference is at [`/docs`](https://gateway-production-e17a.up.railway.app/docs), generated from the same schemas that validate each request ([`/openapi.json`](https://gateway-production-e17a.up.railway.app/openapi.json)). To pay, sign the vault's EIP-712 `Payment { amount, invoiceHash, payTo, deadline }` with the agent key, in the domain `{ name: 'Countersign Vault', version: '1', chainId: 10143, verifyingContract: vault }`, and `POST /v1/payments`.

## What happens to a payment

1. **The contract's rules**, by simulation: the address on file, within the order, not paid before, the account not paused, the agent's signature. Nothing is sent to check them.
2. **The checker** compares the invoice with the order. An error or a timeout is a hold.
3. **Settled** at Monad's Finalized stage (about a second), or **held** for the owner with the reason and a link, or **blocked**.

| Status | Means |
|---|---|
| `settled` | Paid; the transaction is final |
| `held` | Waiting for the owner; `reasonText` says why, `statusUrl` shows it |
| `blocked` | Never payable as it stands (over what is left, already paid, a closed order) |
| `requested`, `checking`, `released`, `settling` | On the way |

## Invoices paid by bank transfer: advice

A bank transfer happens inside the bank, so Countersign cannot stop one. It can check one: the invoice's bank account against the account the owner put on file for that supplier (with their passkey), plus the same checks as a USDC invoice. The answer is `match`, `mismatch` or `unsure`, with a sentence to relay (`said`) and the evidence; nothing is paid.

- MCP: `check_invoice` with `bankTransfer: true` and the invoice's full text as `invoiceText`.
- Web API: `POST /v1/advice` `{ account, vault, document }`.

On `mismatch`, don't pay it. On `unsure`, confirm the account with the supplier by phone, on a number you already have. Try it on the demo site's KS-1007 ("we have moved to a new bank": mismatch) and KS-1008 (match).

## A payment's record

`GET /v1/payments/{id}/record` (or `cs.record(id)`) is one JSON file per payment: the payment, the document the agent gave, the checks and the hash of their evidence, who decided and where that decision is on Monad, and the settlement. Check it against Monad yourself:

```bash
npx countersign-verify countersign-record-0x….json
```

It recomputes the hashes and reads the decision's `DecisionRecorded` and the settlement's `PaymentExecuted` from Monad's own RPC. An account's payments and advice come as one CSV: `GET /v1/accounts/{account}/records.csv`.

## Identity of an invoice

`invoiceHash = keccak256(abi.encode(supplierId, normalizedNumber))`, with the number normalized (NFKC, trimmed, spaces collapsed, upper case). The same supplier's same invoice is one payment, however often it is sent. The SDK does this for you (`invoiceHash()`); test vectors are in [`packages/shared/test/fixtures/invoice-ids.json`](../../packages/shared/test/fixtures/invoice-ids.json).

## Limits

The contract makes paying the wrong party impossible. The checker is a detector with a measured catch rate, not a guarantee. Hosted mode holds keys for you, bounded by the contract. Testnet only. More in the [architecture](../plan/00-architecture.md).
