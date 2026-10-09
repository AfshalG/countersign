/**
 * Slice 8: the scripted agent (apps/scripted-agent, no model) reads every demo document from the
 * supplier's live site and pays it, proposes it or leaves it, through the SDK against a live
 * gateway; each case is scored against what its document says should happen (`case.expect`).
 *
 * This script plays two people: the agent (the demo agent's key, the service token) and the
 * account's owner (a fresh software passkey: on a phone it is Face ID), who sets up a fresh judge
 * account, approves the clean quote and the shop, and refuses the poisoned quote. A fresh account
 * each run, because invoice numbers are per account. Adds 0.01 USDC to the account from the
 * deployer so the run's three orders fit. Spends about 0.25 MON and 0.006 USDC.
 *
 *   pnpm --filter @countersign/gateway agent-run [gateway URL] [supplier site URL]
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, USDC } from '@countersign/chain';
import { Countersign } from '@countersign/sdk';
import { loadEnv } from '@countersign/shared';
import {
  compare,
  decide,
  pageText,
  readDocument,
  readShop,
  type Actual,
  type Expected,
  type Memory,
  type Persona,
} from '@countersign/scripted-agent';
import { SoftPasskey } from './passkey.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const env = loadEnv(
  z.object({
    GATEWAY_RAILWAY_SERVICE_TOKEN: z.string().min(24),
    DEMO_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
);
const gateway = process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app';
const site = process.argv[3] ?? 'https://countersign-supplier-demo.vercel.app';
const owner = SoftPasskey.fromScalar(`0x${randomBytes(32).toString('hex')}`);
const startedAt = new Date();
// Which checker decides (Slice 10): with the real one, cases are scored by `afterSlice10`.
const health = (await (await fetch(`${gateway}/health`)).json()) as { checker?: { kind?: string } };
const realChecker = health.checker?.kind === 'remote';
console.log(`checker: ${realChecker ? 'the checker service (Slice 10)' : 'the stand-in'}`);

const assertion = (challenge: Hex) => {
  const a = owner.sign(challenge);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};
/** The gateway's no-token routes, as the owner's phone calls them. */
async function call<T>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${gateway}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok)
    throw new Error(
      `${method} ${path}: ${String(res.status)} ${json.error ?? ''} ${json.message ?? ''}`,
    );
  return json;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the owner: a fresh judge account, set up, and 0.01 USDC more ----------

const created = await call<{ account: Address; actions: { challenge: Hex }[] }>(
  'POST',
  '/v1/demo/accounts',
  { publicKey: { x: owner.qx, y: owner.qy } },
);
const account = created.account;
await call('POST', `/v1/demo/accounts/${account}/setup`, {
  assertions: created.actions.map((a) => assertion(a.challenge)),
});
console.log(`account ${account} set up by its owner`);
const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const reader = createPublicClient({ chain, transport: http() });
const topUp = await createWalletClient({
  chain,
  transport: http(),
  account: deployer,
}).writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [account, 10_000n],
});
await reader.waitForTransactionReceipt({ hash: topUp });
console.log('0.01 USDC added from the deployer');

// ---------- the agent ----------

const cs = new Countersign({
  gateway,
  token: env.GATEWAY_RAILWAY_SERVICE_TOKEN,
  account,
  agentKey: env.DEMO_AGENT_PRIVATE_KEY as Hex,
});
const memory: Memory = { quotes: new Map() };

/** Waits until the index has an order (it follows finalized blocks). */
async function indexed(orderId: Hex) {
  const until = Date.now() + 45_000;
  for (;;) {
    if ((await cs.orders()).some((o) => o.orderId.toLowerCase() === orderId.toLowerCase())) return;
    if (Date.now() > until) throw new Error(`order ${orderId} not indexed within 45 s`);
    await sleep(1_000);
  }
}
// The demo order set up a moment ago may not be listed yet: the index follows finalized blocks.
for (const until = Date.now() + 45_000; (await cs.orders()).length === 0; await sleep(1_000))
  if (Date.now() > until) throw new Error('the demo order was not indexed within 45 s');

type Approval = {
  status: string;
  summary: { changesAddress?: boolean };
  actions: Record<string, { challenge: Hex }>;
};

/** The owner's decision on a proposal, with the passkey: approve (each action) or refuse. */
async function ownerDecides(id: string, decision: 'approve' | 'refuse') {
  const view = await call<Approval>('GET', `/v1/approvals/${id}`);
  if (decision === 'refuse')
    return call<Approval>('POST', `/v1/approvals/${id}`, {
      action: 'refuse',
      assertion: assertion(view.actions.refuse?.challenge as Hex),
    });
  return call<Approval>('POST', `/v1/approvals/${id}`, {
    action: 'approve',
    assertions: Object.fromEntries(
      Object.entries(view.actions)
        .filter(([k]) => k !== 'refuse')
        .map(([k, a]) => [k, assertion(a.challenge)]),
    ),
  });
}

type Row = {
  step: string;
  persona: Persona;
  expected: Expected | { duplicate: true };
  actual: Actual | { duplicate: boolean };
  ok: boolean;
  why?: string;
  ms: number;
  requestId?: string;
  proposalId?: string;
  tx?: string | null;
  owner?: string;
};
const rows: Row[] = [];
const firstOf = new Map<string, string>();

/** One document: read it, decide, act, score. */
async function runCase(path: string, ownerDecision?: 'approve' | 'refuse', again = false) {
  const t = Date.now();
  const html = await (await fetch(`${site}${path}?account=${account}`)).text();
  const json = (await (await fetch(`${site}${path}?account=${account}&format=json`)).json()) as {
    id: string;
    case: {
      expect: Expected & {
        persona?: Persona;
        afterSlice10?: Expected & { persona?: Persona };
      };
    };
  };
  const today = json.case.expect;
  const after = realChecker ? today.afterSlice10 : undefined;
  const expected: Expected = after ?? today;
  const persona = after?.persona ?? today.persona ?? 'careful';
  const doc = readDocument(pageText(html));
  const action = decide(doc, persona, await cs.orders(), memory);
  const step = again ? `${json.id} again` : json.id;
  const row: Row = { step, persona, expected, actual: { outcome: 'none' }, ok: false, ms: 0 };
  if (action.kind === 'propose') {
    const p = await cs.proposeOrder({
      supplier: action.supplier,
      amount: action.amount,
      expiry: new Date(Date.now() + 30 * 86_400_000),
      document: action.document,
    });
    const view = await call<Approval>('GET', `/v1/approvals/${p.id}`);
    row.proposalId = p.id;
    row.actual = { outcome: 'proposed', changesAddress: view.summary.changesAddress === true };
    if (ownerDecision) {
      const decided = await ownerDecides(p.id, ownerDecision);
      row.owner = decided.status;
      if (decided.status === 'approved') {
        const orderId = keccak256(p.id);
        if (action.quote) memory.quotes.set(action.quote, orderId);
        await indexed(orderId);
      }
    }
  } else if (action.kind === 'pay') {
    const r = await cs.pay({
      order: action.order,
      invoice: action.invoice,
      wait: { timeoutMs: 30_000, pollMs: 300 },
    });
    row.requestId = r.id;
    row.tx = r.tx.hash;
    if (again) {
      row.expected = { duplicate: true };
      row.actual = { duplicate: r.duplicate && r.id === firstOf.get(json.id) };
    } else {
      firstOf.set(json.id, r.id);
      row.actual = { outcome: r.status, reason: r.reason };
    }
  } else if (action.kind === 'advise') {
    // Slice 17: a bank transfer gets advice; the account pays nothing.
    const a = await cs.advise({ order: action.order, document: { text: action.document } });
    row.actual = { outcome: 'advised', advice: a.advice, reason: a.reason };
  } else {
    row.actual = { outcome: action.why };
  }
  row.ms = Date.now() - t;
  if ('duplicate' in row.expected) {
    row.ok = 'duplicate' in row.actual && row.actual.duplicate;
    if (!row.ok) row.why = 'the second send was not the first request';
  } else {
    const c = compare(row.expected, row.actual as Actual);
    row.ok = c.ok;
    if (c.why) row.why = c.why;
  }
  rows.push(row);
  const shown =
    'duplicate' in row.actual
      ? `duplicate: ${String(row.actual.duplicate)}`
      : `${row.actual.outcome}${row.actual.reason ? ` (${row.actual.reason})` : ''}`;
  console.log(
    `${row.ok ? 'ok  ' : 'MISS'} ${step.padEnd(18)} ${persona.padEnd(8)} ${shown}${row.owner ? `, owner: ${row.owner}` : ''}${row.why ? `  <- ${row.why}` : ''}`,
  );
}

/** The shop: the agent proposes Fieldstone Supply from its page; the owner approves. */
async function shop() {
  const t = Date.now();
  const s = readShop(await (await fetch(`${site}/shop?account=${account}`)).text());
  if (!s) throw new Error('could not read the shop page');
  const p = await cs.proposeOrder({
    supplier: { name: s.name, website: `${site}/shop`, payTo: s.payTo },
    amount: '0.002',
    expiry: new Date(Date.now() + 30 * 86_400_000),
    document: `${s.name}: a standing order for studio supplies, 0.002 USDC, paid to ${s.payTo}`,
  });
  const decided = await ownerDecides(p.id, 'approve');
  await indexed(keccak256(p.id));
  const ok = decided.status === 'approved';
  rows.push({
    step: 'shop',
    persona: 'careful',
    expected: { outcome: 'proposed' },
    actual: { outcome: 'proposed' },
    ok,
    ms: Date.now() - t,
    proposalId: p.id,
    owner: decided.status,
  });
  console.log(
    `${ok ? 'ok  ' : 'MISS'} ${'shop'.padEnd(18)} careful  proposed, owner: ${decided.status}`,
  );
}

await runCase('/quotes/q-2210', 'approve');
await runCase('/quotes/q-2211', 'refuse');
await shop();
await runCase('/invoices/ks-1001');
await runCase('/invoices/ks-1001', undefined, true);
for (const id of [
  'ks-1002',
  'ks-1003',
  'ks-1004',
  'ks-1005',
  'nw-77',
  'ks-1006',
  'ks-1007',
  'ks-1008',
])
  await runCase(`/invoices/${id}`);
await runCase('/shop/fs-checkout');
await runCase('/shop/fs-checkout-v2');

const matched = rows.filter((r) => r.ok).length;
console.log(`\n${String(matched)} of ${String(rows.length)} cases ended as their documents say`);
console.log(`explorer: https://testnet.monadexplorer.com/address/${account}`);
const day = startedAt.toISOString().slice(0, 10);
const out = new URL(
  `../results/${day}-scripted-agent${realChecker ? '-checker' : ''}.json`,
  import.meta.url,
);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ startedAt: startedAt.toISOString(), gateway, site, account, checker: realChecker ? 'service' : 'stand-in', matched, cases: rows }, null, 2)}\n`,
);
console.log(
  `results: services/gateway/results/${day}-scripted-agent${realChecker ? '-checker' : ''}.json`,
);
if (matched !== rows.length) process.exitCode = 1;
