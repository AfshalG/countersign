// Pays one 0.001 USDC invoice from a Countersign account on Monad testnet, through the SDK.
//   COUNTERSIGN_TOKEN=… COUNTERSIGN_ACCOUNT=0x… AGENT_PRIVATE_KEY=0x… npm start
import { Countersign } from '@countersign/sdk';

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
};

const cs = new Countersign({
  gateway: process.env.COUNTERSIGN_GATEWAY ?? 'https://gateway-production-e17a.up.railway.app',
  token: need('COUNTERSIGN_TOKEN'),
  account: need('COUNTERSIGN_ACCOUNT'),
  agentKey: need('AGENT_PRIVATE_KEY'), // signs here; never sent anywhere
});

const orders = await cs.orders();
const order = orders.find((o) => BigInt(o.remaining) >= 1_000n);
if (!order) throw new Error('no open order with 0.001 USDC left');
console.log(`order ${order.orderId}: pays only ${order.payTo}, ${order.remaining} base units left`);

const started = Date.now();
const result = await cs.pay({
  order,
  invoice: { number: `QUICKSTART-${Date.now()}`, amount: '0.001', payTo: order.payTo },
  wait: true,
});
console.log(`${result.status} in ${Date.now() - started} ms`);
if (result.reasonText) console.log(result.reasonText);
if (result.tx.hash) console.log(`transaction ${result.tx.hash}`);
console.log(result.statusUrl);
