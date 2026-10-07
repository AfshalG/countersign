/**
 * Slice 6's manual test on Monad testnet (docs/plan/slice-06-gateway.md, "Manual testing"). It
 * starts the real gateway against Slice 5's deployed contracts, drives it over HTTP as an agent and
 * an owner would, and checks every answer against the chain:
 *
 *   1. /health: the database, the finality socket and every relayer's balance
 *   2. one clean payment, settled at Finalized, with its timings
 *   3. the same invoice again: the same request back, no second transaction
 *   4. two payments the contract refuses (a look-alike address, over the new-address cap): no gas
 *   5. a run of 10, with the live feed streaming each change
 *   6. a run of 8 with the gateway killed mid-run and restarted: every request reaches exactly one
 *      final status and no invoice is paid twice (relayer nonces moved once per payment)
 *   7. a held payment approved with the owner's passkey (paid through payWithOwner), after a
 *      stranger's passkey is refused
 *   8. a held payment refused with the owner's passkey
 *
 *   pnpm --filter @countersign/gateway testnet-run
 *
 * Needs the repo's .env (RELAYER_PRIVATE_KEYS, GATEWAY_SERVICE_TOKEN, GATEWAY_DATABASE_URL and the
 * SLICE5_* keys) and Postgres running. Spends about 0.55 MON of relayer gas and 0.0214 test USDC
 * from the gateway's order vault. Writes results/<date>-testnet.json and the gateway's log.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  formatEther,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import {
  accountFactoryAbi,
  chain,
  countersignAccountAbi,
  deployments,
  ENDPOINTS,
  orderVaultAbi,
  WS_URL,
} from '@countersign/chain';
import {
  decisionTypes,
  FINAL_STATUSES,
  loadEnv,
  OUTCOME,
  paymentTypes,
  vaultDomain,
} from '@countersign/shared';
import type { WebAuthnAuth } from '../src/chain/types.js';
import { SoftPasskey } from './passkey.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = join(HERE, '..');
process.loadEnvFile(join(GATEWAY_DIR, '../../.env'));

const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const env = loadEnv(
  z.object({
    RELAYER_PRIVATE_KEYS: z.string().min(1),
    GATEWAY_SERVICE_TOKEN: z.string().min(24),
    GATEWAY_DATABASE_URL: z.url(),
    SLICE5_AGENT_PRIVATE_KEY: privateKey,
    SLICE5_CHECKER_PRIVATE_KEY: privateKey,
    SLICE5_OWNER_P256_KEY: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  }),
);

// ---------- what Slice 5 set up on testnet (contracts/script/Slice05Testnet.s.sol) ----------

const KALIBRE = getAddress('0x90f9931B748B26763161a8191C178Fe425C25fEc'); // the demo supplier
const LOOK_ALIKE = getAddress('0x90f9931b748b26763161a8191c178fe425c25fed'); // last character changed
const SALT = stringToHex('slice 5 testnet', { size: 32 });
const WAIT = 120n;
const ORDER_ID = keccak256(stringToHex('gateway testnet order 2026-002'));
const PORT = 8787;
const BASE = `http://127.0.0.1:${String(PORT)}`;

const client = createPublicClient({ chain, transport: http(ENDPOINTS[0].url) });
const owner = SoftPasskey.fromScalar(env.SLICE5_OWNER_P256_KEY);
const stranger = SoftPasskey.fromScalar(keccak256(stringToHex('not the owner')));
const agent = privateKeyToAccount(env.SLICE5_AGENT_PRIVATE_KEY as Hex);
const relayers = env.RELAYER_PRIVATE_KEYS.split(',').map(
  (k) => privateKeyToAccount(k.trim() as Hex).address,
);

// ---------- results ----------

const startedAt = new Date();
const day = startedAt.toISOString().slice(0, 10);
const resultsDir = join(GATEWAY_DIR, 'results');
mkdirSync(resultsDir, { recursive: true });
const gatewayLog = createWriteStream(join(resultsDir, `${day}-testnet-gateway.log`), {
  flags: 'a',
});
const results: Record<string, unknown> = { startedAt: startedAt.toISOString() };
const failures: string[] = [];

function log(line: string) {
  console.log(line);
}
function check(ok: boolean, what: string) {
  log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

// ---------- the gateway process ----------

let gateway: ChildProcess | undefined;

async function startGateway(label: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      DATABASE_URL: env.GATEWAY_DATABASE_URL,
      MONAD_CHAIN_ID: String(chain.id),
      MONAD_WS_URL: WS_URL,
      RELAYER_PRIVATE_KEYS: env.RELAYER_PRIVATE_KEYS,
      GATEWAY_SERVICE_TOKEN: env.GATEWAY_SERVICE_TOKEN,
      // The account's policy names this key as its checker (Slice 5).
      TEST_CHECKER_PRIVATE_KEY: env.SLICE5_CHECKER_PRIVATE_KEY,
      PORT: String(PORT),
      PUBLIC_URL: BASE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gatewayLog.write(`\n----- ${new Date().toISOString()} start (${label}) -----\n`);
  child.stdout.pipe(gatewayLog, { end: false });
  child.stderr.pipe(gatewayLog, { end: false });
  gateway = child;
  await waitFor(`gateway up (${label})`, 60_000, async () => {
    if (child.exitCode !== null) throw new Error(`gateway exited with ${String(child.exitCode)}`);
    const res = await fetch(`${BASE}/health`).catch(() => undefined);
    return res?.ok === true;
  });
}

function stopGateway(signal: 'SIGKILL' | 'SIGTERM'): Promise<void> {
  const child = gateway;
  gateway = undefined;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.kill(signal);
  });
}

// ---------- HTTP ----------

type View = {
  id: Hex;
  status: string;
  reason: string | null;
  decidedBy: string | null;
  amount: string;
  invoiceHash: Hex;
  tx: { hash: Hex | null; relayer: Address | null; nonce: number | null; block: string | null };
  timings: { checkMs: number | null; personMs: number | null; settleMs: number | null };
};

// The caller names the response shape it expects; the gateway's own tests check the shapes.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GATEWAY_SERVICE_TOKEN}`,
      'content-type': 'application/json',
    },
    body:
      body === undefined
        ? null
        : JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function waitFor(what: string, timeoutMs: number, done: () => Promise<boolean>) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return;
    if (Date.now() > until) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const isFinal = (status: string) => (FINAL_STATUSES as readonly string[]).includes(status);

async function finalView(id: Hex, timeoutMs = 90_000): Promise<View> {
  let view: View | undefined;
  await waitFor(`request ${id} final`, timeoutMs, async () => {
    view = (await api<View>('GET', `/v1/payments/${id}`)).body;
    return isFinal(view.status);
  });
  if (!view) throw new Error('unreachable');
  return view;
}

// ---------- payments ----------

const tag = startedAt.toISOString();
const invoice = (name: string) => keccak256(stringToHex(`gateway testnet ${tag} ${name}`));

type Account = Address;
let account: Account;
let vault: Address;

async function submission(amount: bigint, name: string, payTo = KALIBRE, document?: unknown) {
  const payment = {
    amount,
    invoiceHash: invoice(name),
    payTo,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 2 * 3600),
  };
  const agentSig = await agent.signTypedData({
    domain: vaultDomain(chain.id, vault),
    types: paymentTypes,
    primaryType: 'Payment',
    message: payment,
  });
  return {
    body: {
      vault,
      payment: { ...payment, amount: amount.toString(), deadline: Number(payment.deadline) },
      agentSig,
      ...(document === undefined ? {} : { document }),
    },
    // What the owner's passkey signs to pay this one (payWithOwner): the vault's EIP-712 digest.
    digest: hashTypedData({
      domain: vaultDomain(chain.id, vault),
      types: paymentTypes,
      primaryType: 'Payment',
      message: payment,
    }),
  };
}

async function pay(amount: bigint, name: string, payTo?: Address, document?: unknown) {
  const { body, digest } = await submission(amount, name, payTo, document);
  const res = await api<{ created: boolean; request: View }>('POST', '/v1/payments', {
    account,
    ...body,
  });
  return { ...res, digest };
}

async function run(size: number, amount: bigint, name: string) {
  const payments = [];
  for (let i = 0; i < size; i++) {
    payments.push((await submission(amount, `${name} #${String(i + 1)}`)).body);
  }
  const res = await api<{ runId: Hex; requests: { id: Hex }[] }>('POST', '/v1/runs', {
    account,
    payments,
  });
  if (res.status !== 201) throw new Error(`run refused: ${JSON.stringify(res.body)}`);
  return res.body;
}

type RunView = { size: number; byStatus: Record<string, number>; requests: View[] };
async function runView(id: Hex) {
  return (await api<RunView>('GET', `/v1/runs/${id}`)).body;
}
async function finalRun(id: Hex, timeoutMs = 180_000) {
  let view: RunView | undefined;
  await waitFor(`run ${id} final`, timeoutMs, async () => {
    view = await runView(id);
    return view.requests.every((r) => isFinal(r.status));
  });
  if (!view) throw new Error('unreachable');
  return view;
}

const wire = (a: WebAuthnAuth) => ({
  ...a,
  challengeIndex: a.challengeIndex.toString(),
  typeIndex: a.typeIndex.toString(),
});

// ---------- chain reads ----------

const spent = () =>
  client.readContract({ address: vault, abi: orderVaultAbi, functionName: 'spent' });
const paid = (invoiceHash: Hex) =>
  client.readContract({
    address: vault,
    abi: orderVaultAbi,
    functionName: 'paid',
    args: [invoiceHash],
  });
const nonces = () =>
  Promise.all(
    relayers.map((address) => client.getTransactionCount({ address, blockTag: 'latest' })),
  );
const balances = () => Promise.all(relayers.map((address) => client.getBalance({ address })));
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

async function receiptOk(hash: Hex | null) {
  if (!hash) return false;
  const r = await client.getTransactionReceipt({ hash }).catch(() => undefined);
  return r?.status === 'success';
}

// ---------- the run ----------

async function main() {
  log(`Slice 6 testnet run, ${tag}`);

  // Preflight: the account, the vault, the keys in its policy, and the typed data the vault hashes.
  account = await client.readContract({
    address: deployments.accountFactory,
    abi: accountFactoryAbi,
    functionName: 'predictAccount',
    args: [owner.qx, owner.qy, WAIT, SALT],
  });
  vault = await client.readContract({
    address: account,
    abi: countersignAccountAbi,
    functionName: 'vaultOf',
    args: [ORDER_ID],
  });
  const policy = await client.readContract({
    address: account,
    abi: countersignAccountAbi,
    functionName: 'policy',
  });
  const checkerAddress = privateKeyToAccount(env.SLICE5_CHECKER_PRIVATE_KEY as Hex).address;
  check(getAddress(policy.agentKey) === agent.address, 'the policy names our agent key');
  check(getAddress(policy.checkerKey) === checkerAddress, 'the policy names our checker key');
  const sample = await submission(1n, 'digest check');
  const onChainDigest = await client.readContract({
    address: vault,
    abi: orderVaultAbi,
    functionName: 'paymentDigest',
    args: [
      {
        amount: 1n,
        invoiceHash: sample.body.payment.invoiceHash,
        payTo: KALIBRE,
        deadline: BigInt(sample.body.payment.deadline),
      },
    ],
  });
  check(onChainDigest === sample.digest, 'our EIP-712 payment digest equals the vault’s');
  const remaining = await client.readContract({
    address: vault,
    abi: orderVaultAbi,
    functionName: 'remaining',
  });
  log(`account ${account}, vault ${vault}, ${remaining.toString()} USDC base units left`);
  if (remaining < 21_400n) throw new Error('the order vault has too little USDC for this run');
  const spentBefore = await spent();
  const noncesBefore = await nonces();
  const balancesBefore = await balances();
  results.preflight = { account, vault, remaining: remaining.toString() };

  // 1. health
  await startGateway('first start');
  const health = (await fetch(`${BASE}/health`).then((r) => r.json())) as Record<string, unknown>;
  log(`health: ${JSON.stringify(health)}`);
  check(health.db === true, '/health reports the database');
  check(
    Array.isArray(health.relayers) && health.relayers.length === relayers.length,
    '/health lists every relayer',
  );
  results.health = health;

  // 2. one clean payment
  log('\n2. one clean payment');
  const t0 = Date.now();
  const one = await pay(1_000n, 'single INV-1');
  check(one.status === 201 && one.body.created, 'accepted as a new request');
  const oneFinal = await finalView(one.body.request.id);
  const oneWall = Date.now() - t0;
  check(oneFinal.status === 'settled', `settled (${oneFinal.status})`);
  check(await receiptOk(oneFinal.tx.hash), 'its transaction succeeded on chain');
  log(
    `  request to finalized ${String(oneWall)} ms; check ${String(oneFinal.timings.checkMs)} ms, send to finalized ${String(oneFinal.timings.settleMs)} ms`,
  );
  results.single = { wallMs: oneWall, view: oneFinal };

  // 3. the same invoice again
  log('\n3. the same invoice again');
  const again = await api<{ created: boolean; request: View }>('POST', '/v1/payments', {
    account,
    ...(await submission(1_000n, 'single INV-1')).body,
  });
  // The deadline differs, but the request ID is (account, vault, invoice): the same request comes back.
  check(again.status === 200 && !again.body.created, 'not created again (200)');
  check(again.body.request.id === one.body.request.id, 'the same request ID');
  check(again.body.request.tx.hash === oneFinal.tx.hash, 'the same transaction, none added');
  results.duplicate = {
    status: again.status,
    sameId: again.body.request.id === one.body.request.id,
  };

  // 4. payments the contract refuses: nothing is sent, so no gas
  log('\n4. refused by the contract');
  const lookAlike = await pay(1_000n, 'look-alike INV-2', LOOK_ALIKE);
  // An address not on file is held for the owner to compare the two addresses (not final).
  const lookAlikeFinal = await finalOrHeld(lookAlike.body.request.id);
  check(
    ['blocked', 'held'].includes(lookAlikeFinal.status) && lookAlikeFinal.tx.hash === null,
    `look-alike address: ${lookAlikeFinal.status}, ${String(lookAlikeFinal.reason)}, no transaction`,
  );
  const overCap = await pay(3_000n, 'over the new-address cap INV-3');
  const overCapFinal = await finalOrHeld(overCap.body.request.id);
  check(
    ['blocked', 'held'].includes(overCapFinal.status) && overCapFinal.tx.hash === null,
    `over the new-address cap: ${overCapFinal.status}, ${String(overCapFinal.reason)}, no transaction`,
  );
  results.refused = { lookAlike: lookAlikeFinal, overCap: overCapFinal };

  // 5. a run of 10, watched through the feed
  log('\n5. a run of 10');
  const feed = new AbortController();
  let feedEvents = 0;
  const feedDone = fetch(`${BASE}/v1/feed`, {
    headers: { authorization: `Bearer ${env.GATEWAY_SERVICE_TOKEN}` },
    signal: feed.signal,
  })
    .then(async (res) => {
      if (!res.body) return;
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        feedEvents += (decoder.decode(chunk as Uint8Array).match(/^event: status$/gm) ?? []).length;
      }
    })
    .catch(() => undefined);
  const r0 = Date.now();
  const ten = await run(10, 500n, 'run of 10');
  const tenFinal = await finalRun(ten.runId);
  const tenWall = Date.now() - r0;
  feed.abort();
  await feedDone;
  check(tenFinal.byStatus.settled === 10, `all 10 settled (${JSON.stringify(tenFinal.byStatus)})`);
  check(
    feedEvents >= 30,
    `the feed streamed the changes (${String(feedEvents)} events for 10 requests)`,
  );
  log(`  first request to last finalized ${String(tenWall)} ms`);
  results.runOf10 = { wallMs: tenWall, feedEvents, byStatus: tenFinal.byStatus };

  // 6. killed mid-run, restarted
  log('\n6. a run of 8, the gateway killed mid-run');
  const noncesMid = await nonces();
  const eight = await run(8, 300n, 'crash run');
  await waitFor('some payments in flight', 60_000, async () => {
    const v = await runView(eight.runId);
    return (v.byStatus.settling ?? 0) + (v.byStatus.settled ?? 0) >= 2;
  });
  const atKill = await runView(eight.runId);
  log(`  killing the gateway (SIGKILL) at ${JSON.stringify(atKill.byStatus)}`);
  await stopGateway('SIGKILL');
  await startGateway('after the kill');
  const eightFinal = await finalRun(eight.runId);
  const eightSettled = eightFinal.requests.filter((r) => r.status === 'settled');
  check(
    eightSettled.length === 8,
    `all 8 settled after the restart (${JSON.stringify(eightFinal.byStatus)})`,
  );
  const paidFlags = await Promise.all(eightFinal.requests.map((r) => paid(r.invoiceHash)));
  check(paidFlags.every(Boolean), 'the vault records every invoice as paid');
  const okReceipts = await Promise.all(eightSettled.map((r) => receiptOk(r.tx.hash)));
  check(okReceipts.every(Boolean), 'every recorded transaction succeeded');
  const noncesAfterCrash = await nonces();
  const sentDuringCrash = sum(noncesAfterCrash) - sum(noncesMid);
  check(
    sentDuringCrash === 8,
    `relayers sent exactly 8 transactions for 8 payments (${String(sentDuringCrash)})`,
  );
  results.crash = {
    atKill: atKill.byStatus,
    after: eightFinal.byStatus,
    transactions: sentDuringCrash,
  };

  // 7. held, then approved with the owner's passkey
  log('\n7. held, approved with the passkey');
  const held = await pay(1_000n, 'held INV-4', KALIBRE, { testHold: 'amount_mismatch' });
  const heldView = await finalOrHeld(held.body.request.id);
  check(
    heldView.status === 'held' && heldView.reason === 'amount_mismatch',
    `held (${heldView.status}, ${String(heldView.reason)})`,
  );
  const strangerTry = await api<{ error?: string }>(
    'POST',
    `/v1/payments/${held.body.request.id}/approve`,
    {
      ownerAuth: wire(stranger.sign(held.digest)),
    },
  );
  check(
    strangerTry.status === 422 && strangerTry.body.error === 'invalid_passkey',
    `a stranger's passkey is refused (${String(strangerTry.status)})`,
  );
  const a0 = Date.now();
  const approved = await api<View>('POST', `/v1/payments/${held.body.request.id}/approve`, {
    ownerAuth: wire(owner.sign(held.digest)),
  });
  check(
    approved.status === 200 && approved.body.status === 'released',
    `the owner's passkey releases it (${String(approved.status)})`,
  );
  const approvedFinal = await finalView(held.body.request.id);
  check(
    approvedFinal.status === 'settled' && approvedFinal.decidedBy === 'user_once',
    `settled through payWithOwner (${approvedFinal.status}, ${String(approvedFinal.decidedBy)})`,
  );
  check(await receiptOk(approvedFinal.tx.hash), 'its transaction succeeded on chain');
  results.approved = { approveToFinalizedMs: Date.now() - a0, view: approvedFinal };

  // 8. held, then refused with the owner's passkey
  log('\n8. held, refused with the passkey');
  const toRefuse = await pay(1_000n, 'refused INV-5', KALIBRE, { testHold: 'items_mismatch' });
  await finalOrHeld(toRefuse.body.request.id);
  const decision = {
    invoiceHash: toRefuse.body.request.invoiceHash,
    outcome: OUTCOME.refused,
    reasonHash: keccak256(stringToHex('items differ from the order')),
    evidenceHash: keccak256(stringToHex('INV-5 evidence')),
  };
  const decisionDigest = hashTypedData({
    domain: vaultDomain(chain.id, vault),
    types: decisionTypes,
    primaryType: 'Decision',
    message: decision,
  });
  const refused = await api<View>('POST', `/v1/payments/${toRefuse.body.request.id}/refuse`, {
    ownerAuth: wire(owner.sign(decisionDigest)),
    decision: { reasonHash: decision.reasonHash, evidenceHash: decision.evidenceHash },
  });
  check(
    refused.status === 200 && refused.body.status === 'refused' && refused.body.tx.hash === null,
    `refused, nothing sent (${String(refused.status)}, ${refused.body.status})`,
  );
  check(!(await paid(decision.invoiceHash)), 'the vault never paid it');
  results.refusedByOwner = refused.body;

  // Totals
  await stopGateway('SIGTERM');
  const spentAfter = await spent();
  const noncesAfter = await nonces();
  const balancesAfter = await balances();
  const settledCount = 1 + 10 + 8 + 1;
  const transactions = sum(noncesAfter) - sum(noncesBefore);
  const usdc = spentAfter - spentBefore;
  const mon =
    balancesBefore.reduce((a, b) => a + b, 0n) - balancesAfter.reduce((a, b) => a + b, 0n);
  check(
    usdc === 1_000n + 5_000n + 2_400n + 1_000n,
    `the vault paid exactly ${usdc.toString()} base units (expected 9400)`,
  );
  check(
    transactions === settledCount,
    `${String(transactions)} transactions for ${String(settledCount)} payments`,
  );
  results.totals = { transactions, usdcPaid: usdc.toString(), monSpent: formatEther(mon) };
  log(`\nrelayer gas: ${formatEther(mon)} MON for ${String(transactions)} transactions`);
}

/** A held request is not final; wait until it is held (or final, which is a failure for the caller). */
async function finalOrHeld(id: Hex): Promise<View> {
  let view: View | undefined;
  await waitFor(`request ${id} held`, 60_000, async () => {
    view = (await api<View>('GET', `/v1/payments/${id}`)).body;
    return view.status === 'held' || isFinal(view.status);
  });
  if (!view) throw new Error('unreachable');
  return view;
}

try {
  await main();
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
  log(`\nstopped: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await stopGateway('SIGTERM');
  results.failures = failures;
  results.finishedAt = new Date().toISOString();
  const file = join(resultsDir, `${day}-testnet.json`);
  writeFileSync(
    file,
    `${JSON.stringify(results, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
  );
  gatewayLog.end();
  log(
    `\n${failures.length === 0 ? 'ALL PASSED' : `${String(failures.length)} FAILED`}; results in ${file}`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}
