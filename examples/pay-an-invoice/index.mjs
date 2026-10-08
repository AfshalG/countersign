// Pays Kalibre Studio's clean demo invoice (0.001 USDC) from your Countersign test account, through
// the SDK, the way an agent would: it reads the invoice from the supplier's own page and passes it
// along, so the checker reads it too.
//   npm run account   (once: makes your test account and writes .env)
//   npm start
import { Countersign } from '@countersign/sdk';

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name} (npm run account writes it)`);
  return value;
};
const account = need('COUNTERSIGN_ACCOUNT');
const cs = new Countersign({
  gateway: process.env.COUNTERSIGN_GATEWAY ?? 'https://gateway-production-e17a.up.railway.app',
  token: need('COUNTERSIGN_TOKEN'), // reaches only this account
  account,
  agentKey: need('COUNTERSIGN_AGENT_KEY'), // signs here; never sent anywhere
});

const orders = await cs.orders();
const order = orders.find((o) => BigInt(o.remaining) >= 1_000n);
if (!order) throw new Error('no open order with 0.001 USDC left');
console.log(`order ${order.orderId}: pays only ${order.payTo}, ${order.remaining} base units left`);

// The supplier's page for this account; a new run label each time makes it a new invoice.
const page = `https://countersign-supplier-demo.vercel.app/invoices/ks-1001?account=${account}&run=${Date.now().toString(36).slice(-6)}`;
const invoice = await (await fetch(`${page}&format=json`)).json();
const html = await (await fetch(page)).text();

const started = Date.now();
const result = await cs.pay({
  order,
  invoice: {
    number: invoice.number,
    amount: invoice.totalUsdc,
    payTo: invoice.payTo,
    document: { html },
  },
  wait: true,
});
console.log(`${invoice.number}: ${result.status} in ${Date.now() - started} ms`);
if (result.reasonText) console.log(result.reasonText);
if (result.tx.hash) console.log(`transaction ${result.tx.hash}`);
console.log(result.statusUrl);
