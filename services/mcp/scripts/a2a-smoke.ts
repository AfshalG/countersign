/**
 * The A2A door on the deployed MCP server (Slice 19 part B), with the A2A project's own client:
 * read the Agent Card, list the open orders, and send a payment to a look-alike address, which is
 * held (an auth-required task with the owner's approval link). Spends nothing: a hold sends no
 * transaction.
 *
 *   pnpm --filter @countersign/mcp-server a2a-smoke [base URL]
 */
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const token = process.env.MCP_SERVER_TOKEN;
if (!token) throw new Error('MCP_SERVER_TOKEN is not set');
const base = process.argv[2] ?? 'https://countersign-mcp.vercel.app';
const fetchImpl: typeof fetch = (input, init) => {
  const req = new Request(input instanceof Request ? input : String(input), init);
  if (new URL(req.url).pathname === '/api/a2a') req.headers.set('authorization', `Bearer ${token}`);
  return fetch(req);
};
const client = await new ClientFactory({
  transports: [new JsonRpcTransportFactory({ fetchImpl })],
  cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
}).createFromUrl(base);
const card = await client.getAgentCard();
console.log(`card: ${card.name}, skills ${card.skills.map((s) => s.id).join(', ')}`);

const send = async (data: Record<string, unknown>) => {
  const message: Message = {
    messageId: crypto.randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'data', value: data },
        metadata: undefined,
        filename: '',
        mediaType: 'application/json',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
  return (await client.sendMessage({
    tenant: '',
    message,
    configuration: undefined,
    metadata: undefined,
  })) as Task;
};
const text = (t: Task) =>
  (t.status?.message?.parts ?? [])
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join(' ');

const orders = await send({ skill: 'list_open_orders' });
const order = orders.artifacts
  .flatMap((a) => a.parts)
  .map((p) =>
    p.content?.$case === 'data'
      ? (p.content.value as {
          orders?: { orderId: string; addressOnFile: string; remainingUsdc: string }[];
        })
      : {},
  )
  .find((d) => d.orders)?.orders?.[0];
console.log(
  `list_open_orders: ${String(TaskState[orders.status?.state ?? 0])}; first order ${order?.orderId ?? 'none'} (${order?.remainingUsdc ?? '?'} USDC left)`,
);
if (!order) throw new Error('no open order');

const onFile = order.addressOnFile.toLowerCase();
// A realistic look-alike, as address poisoning makes them: the same first six and last four
// characters, a random-looking middle (not a run of one letter).
const middle = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) =>
  b.toString(16).padStart(2, '0'),
).join('');
const lookAlike = `${onFile.slice(0, 8)}${middle}${onFile.slice(-4)}`;
const held = await send({
  skill: 'pay_invoice',
  orderId: order.orderId,
  invoiceNumber: `A2A-${String(Date.now())}`,
  amount: '0.001',
  payTo: lookAlike,
});
console.log(`pay_invoice to a look-alike: ${String(TaskState[held.status?.state ?? 0])}`);
console.log(`  ${text(held).replace(/\n/g, ' | ')}`);
