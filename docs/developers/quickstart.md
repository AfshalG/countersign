# Developer quickstart

Countersign gives an AI agent an account that pays only what its owner approved. You can reach it three ways; all three go to the same gateway and the same contracts on Monad testnet.

| | Use it when | Agent key |
|---|---|---|
| **SDK** (`@countersign/sdk`) | Your agent runs your TypeScript | Yours: it signs in your process |
| **MCP server** | Your agent speaks MCP (Claude Code today) | Held by the server for the account (hosted mode) |
| **Web API** | Anything else | Yours: sign the payment as the SDK does |

## 1. Get an account (hackathon week)

Self-serve accounts arrive with the passkey app (Slice 9). Until then, message us and we set up a testnet account for your agent: an owner passkey, one supplier, one funded order, and an agent key for you. You get:

- the gateway URL (`https://gateway-production-e17a.up.railway.app`) and a token;
- your account address and agent key (SDK or web API), or an MCP token (MCP).

## 2a. The SDK

```bash
npm i https://github.com/AfshalG/countersign/releases/download/sdk-v0.1.1/countersign-sdk-0.1.1.tgz
```

[`examples/pay-an-invoice`](../../examples/pay-an-invoice) is a complete script: it lists your open orders and pays one invoice of 0.001 USDC, waiting until it is settled at Monad's Finalized stage.

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

## Identity of an invoice

`invoiceHash = keccak256(abi.encode(supplierId, normalizedNumber))`, with the number normalized (NFKC, trimmed, spaces collapsed, upper case). The same supplier's same invoice is one payment, however often it is sent. The SDK does this for you (`invoiceHash()`); test vectors are in [`packages/shared/test/fixtures/invoice-ids.json`](../../packages/shared/test/fixtures/invoice-ids.json).

## Limits

The contract makes paying the wrong party impossible. The checker is a detector with a measured catch rate, not a guarantee. Hosted mode holds keys for you, bounded by the contract. Testnet only. More in the [architecture](../plan/00-architecture.md).
