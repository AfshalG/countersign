# @countersign/sdk

Give an AI agent a Countersign account. The account is a contract on Monad that pays only the suppliers the owner approved, at their addresses on file, within approved orders. Your agent pays inside those rules with no click; anything else is held for the owner, with the reason in plain words and a link.

```bash
npm i https://github.com/AfshalG/countersign/releases/download/sdk-v0.2.0/countersign-sdk-0.2.0.tgz
npx countersign-test-account > .env   # your own testnet account, agent key and token (Node)
```

Works with npm, pnpm, yarn and bun; Node 22+, Bun, Deno and edge runtimes. One dependency: viem.

```ts
import { Countersign } from '@countersign/sdk';

const cs = new Countersign({
  gateway: 'https://gateway-production-e17a.up.railway.app',
  token: process.env.COUNTERSIGN_TOKEN!, // your account's token (cs_…)
  account: process.env.COUNTERSIGN_ACCOUNT! as `0x${string}`, // your Countersign account
  agentKey: process.env.COUNTERSIGN_AGENT_KEY! as `0x${string}`, // signs here; never sent anywhere
});

const [order] = await cs.orders(); // what is approved, and what is left
const result = await cs.pay({
  order,
  invoice: { number: 'INV-0042', amount: '12.50', payTo: '0x90f9…5fEc' },
  wait: true,
});

if (result.status === 'held') console.log(result.reasonText, result.statusUrl);
```

| Method                                                 | Does                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `orders()`                                             | Open orders: the only address each pays, what is left (read from the chain), expiry                                      |
| `pay({ order, invoice, wait? })`                       | Pays an invoice. The same supplier's same invoice number is one payment, however often it is sent or however it is typed |
| `check({ order, invoice })`                            | The same check with nothing paid: `would_settle`, `held` or `blocked`                                                    |
| `payMany(inputs)`                                      | A run of up to 500 invoices                                                                                              |
| `watch({ runId?, signal? })`                           | Live status changes (Server-Sent Events)                                                                                 |
| `status(id)`, `run(id)`, `proposal(id)`                | Look one up                                                                                                              |
| `proposeOrder({ supplier, amount, expiry, document })` | Proposes a supplier and an order; nothing changes until the owner signs with their passkey                               |
| `register({ fromBlock })`                              | Has the gateway index your account's orders                                                                              |

Every failure is a `CountersignError` with a `code` (`malformed`, `unauthorized`, `unknown_order`, `chain_unavailable`, `network`, …) and, for bad input, the fields. Amounts are decimal strings (`'12.50'`) or bigints of USDC base units, never floats.

**What the account guarantees, and what it does not.** The contract makes paying the wrong party impossible: a look-alike address, a supplier not on file, more than the order, an invoice paid before. A checker also compares each invoice with its order, to catch the right supplier billing the wrong amount; it can hold a payment but never release one. Testnet only.

Source, docs and the API reference: https://github.com/AfshalG/countersign · MIT
