/**
 * Spike 3's payment run: sends one scenario through N relayer wallets and follows every
 * transaction from send to Finalized, timing each block's stages from monadNewHeads.
 *
 *   pnpm run run-scenario --arm vaults --wallets 8 --label s1-vaults-8w
 *   pnpm run run-scenario --arm account --wallets 8 --label s1-account-8w
 *   pnpm run run-scenario --arm vaults --wallets 8 --scenario duplicates --label s3-dupes-8w
 *
 * Writes results/run-<label>.json. Invoice IDs come from the label, so a label is used once.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  hashTypedData,
  http,
  keccak256,
  parseEther,
  parseGwei,
  toHex,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import {
  accountAbi,
  accountDomain,
  accountPaymentTypes,
  client,
  deployed,
  ENDPOINTS,
  isSetName,
  MULTICALL3,
  multicall3Abi,
  ORDERS,
  READ_URL,
  setFile,
  toJson,
  USDC_PER_PAYMENT,
  vaultAbi,
  vaultDomain,
  vaultPaymentTypes,
  type OrderSet,
} from './chain.js';
import { NonceAllocator } from './nonces.js';
import { Pacer } from './pace.js';
import { summarise, type TxRecord } from './report.js';
import { rpc, RpcError } from './rpc.js';
import { settings } from './settings.js';
import { StageTracker } from './stages.js';

const RUN_LIMIT_MS = 8 * 60_000;
setTimeout(() => {
  console.error('run did not finish within 8 minutes');
  process.exit(1);
}, RUN_LIMIT_MS).unref();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

// ---------- arguments ----------

const { values } = parseArgs({
  options: {
    arm: { type: 'string' },
    wallets: { type: 'string' },
    scenario: { type: 'string', default: 'single' },
    set: { type: 'string', default: 's1' },
    label: { type: 'string' },
    count: { type: 'string', default: String(200) },
    policy: { type: 'string', default: 'ordered' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const arm = values.arm;
const walletCount = Number(values.wallets);
const scenario = values.scenario;
const setName = values.set;
const label = values.label ?? '';
const dryRun = values['dry-run'];
// Fewer than 200 only for a smoke test of the script itself; results are always labelled with the count.
const count = Number(values.count);
// How transactions reach the endpoints. spread: every transaction to whichever endpoint is free
// (a wallet's nonces can arrive out of order). ordered: each wallet keeps to one endpoint and sends
// its next nonce only after the previous one was accepted.
const policy = values.policy;
if (arm !== 'vaults' && arm !== 'account') throw new Error('--arm must be vaults or account');
if (
  !Number.isInteger(walletCount) ||
  walletCount < 1 ||
  walletCount > settings.RELAYER_PRIVATE_KEYS.length
)
  throw new Error(`--wallets must be 1 to ${String(settings.RELAYER_PRIVATE_KEYS.length)}`);
if (scenario !== 'single' && scenario !== 'duplicates')
  throw new Error('--scenario must be single or duplicates');
if (scenario === 'duplicates' && walletCount < 2)
  throw new Error('duplicates need at least 2 wallets (each copy from a different sender)');
if (!isSetName(setName)) throw new Error('--set must be s1 or s2');
if (policy !== 'spread' && policy !== 'ordered')
  throw new Error('--policy must be spread or ordered');
if (!Number.isInteger(count) || count < 1 || count > ORDERS)
  throw new Error(`--count must be 1 to ${String(ORDERS)}`);
if (!/^[a-z0-9-]{3,40}$/.test(label))
  throw new Error('--label: 3-40 lowercase letters, digits or dashes');
const resultFile = new URL(`../results/run-${label}.json`, import.meta.url);
if (existsSync(resultFile))
  throw new Error(`label ${label} was already used; its invoices are paid`);
if (!existsSync(setFile(setName)))
  throw new Error(`orders for ${setName} not set up; run pnpm run open-orders ${setName}`);
const orders = JSON.parse(readFileSync(setFile(setName), 'utf8')) as OrderSet;

const deployer = privateKeyToAccount(settings.DEPLOYER_PRIVATE_KEY);
const checker = privateKeyToAccount(settings.SPIKE3_CHECKER_PRIVATE_KEY);
if (checker.address !== deployed.checker)
  throw new Error('SPIKE3_CHECKER_PRIVATE_KEY does not match the deployed checker');
const relayers: PrivateKeyAccount[] = settings.RELAYER_PRIVATE_KEYS.slice(0, walletCount).map((k) =>
  privateKeyToAccount(k),
);

// ---------- the payments, signed by the checker ----------

type Intent = { order: number; copy: number; wallet: number; to: Address; data: Hex; digest: Hex };
const intents: Intent[] = [];
const copies = scenario === 'duplicates' ? 2 : 1;
for (let i = 0; i < count; i++) {
  const invoiceId = keccak256(toHex(`${label}:${String(i)}`));
  const supplier = orders.suppliers[i] as Address;
  let to: Address;
  let data: Hex;
  let digest: Hex;
  if (arm === 'vaults') {
    to = orders.vaults[i] as Address;
    const typed = {
      domain: vaultDomain(to),
      types: vaultPaymentTypes,
      primaryType: 'Payment',
      message: { invoiceId, amount: USDC_PER_PAYMENT, payTo: supplier },
    } as const;
    digest = hashTypedData(typed);
    data = encodeFunctionData({
      abi: vaultAbi,
      functionName: 'pay',
      args: [invoiceId, USDC_PER_PAYMENT, await checker.signTypedData(typed)],
    });
  } else {
    to = deployed.account;
    const orderId = BigInt(orders.accountOrderIds[i] as string);
    const typed = {
      domain: accountDomain,
      types: accountPaymentTypes,
      primaryType: 'Payment',
      message: { orderId, invoiceId, amount: USDC_PER_PAYMENT, payTo: supplier },
    } as const;
    digest = hashTypedData(typed);
    data = encodeFunctionData({
      abi: accountAbi,
      functionName: 'pay',
      args: [orderId, invoiceId, USDC_PER_PAYMENT, await checker.signTypedData(typed)],
    });
  }
  // A duplicate's second copy comes from a different wallet, as from a second agent.
  for (let c = 0; c < copies; c++)
    intents.push({ order: i, copy: c, wallet: (i + c) % walletCount, to, data, digest });
}

// The contract must compute the same digest the checker signed; checked once before any MON is spent.
const first = intents[0] as Intent;
const onChainDigest =
  arm === 'vaults'
    ? await client.readContract({
        address: first.to,
        abi: vaultAbi,
        functionName: 'paymentDigest',
        args: [keccak256(toHex(`${label}:0`)), USDC_PER_PAYMENT],
      })
    : await client.readContract({
        address: deployed.account,
        abi: accountAbi,
        functionName: 'paymentDigest',
        args: [
          BigInt(orders.accountOrderIds[0] as string),
          keccak256(toHex(`${label}:0`)),
          USDC_PER_PAYMENT,
        ],
      });
if (onChainDigest !== first.digest)
  throw new Error(`digest mismatch: signed ${first.digest}, contract ${onChainDigest}`);

// ---------- gas, fees and funding ----------

// One hard-coded limit per run (Monad advice: estimate plus 7.5%), from three samples;
// a sample that would revert stops the run here, before anything is sent.
const samples = [0, Math.floor(intents.length / 2), intents.length - 1].map(
  (k) => intents[k] as Intent,
);
// Estimated from the deployer: anyone may submit a checker-signed payment, and the relayers may still hold no MON.
const estimates = await Promise.all(
  samples.map((s) => client.estimateGas({ account: deployer.address, to: s.to, data: s.data })),
);
const executionGas = estimates.reduce((a, b) => (a > b ? a : b));
const gasLimit = (executionGas * 1075n) / 1000n;
const latest = await client.getBlock();
const baseFee = latest.baseFeePerGas ?? parseGwei('100');
const priorityFee = parseGwei('2');
const maxFee = (baseFee * 5n) / 4n + priorityFee;
const chargedPrice = baseFee + priorityFee;
console.log(
  `${label}: ${String(intents.length)} transactions, ${String(walletCount)} wallets; execution gas ${String(executionGas)}, limit ${String(gasLimit)}, base fee ${formatGwei(baseFee)} gwei`,
);

const perWallet = relayers.map((_, w) => intents.filter((x) => x.wallet === w).length);
const needs = perWallet.map((count) => BigInt(count) * gasLimit * maxFee + parseEther('0.01'));
const balances = await Promise.all(relayers.map((r) => client.getBalance({ address: r.address })));
const topUps = needs.map((need, w) =>
  need > (balances[w] as bigint) ? need - (balances[w] as bigint) + parseEther('0.02') : 0n,
);
const totalTopUp = topUps.reduce((a, b) => a + b, 0n);
const deployerBalance = await client.getBalance({ address: deployer.address });
if (totalTopUp + parseEther('0.05') > deployerBalance)
  throw new Error(
    `not enough MON: relayers need ${formatEther(totalTopUp)} more, deployer has ${formatEther(deployerBalance)}`,
  );
if (dryRun) {
  console.log(
    `dry run: relayers need ${formatEther(totalTopUp)} MON more; run would cost about ${formatEther(BigInt(intents.length) * gasLimit * chargedPrice)} MON. Nothing sent.`,
  );
  process.exit(0);
}
if (totalTopUp > 0n) {
  // Monad's reserve balance: an account under 10 MON may send MON out only in an "emptying
  // transaction", one with no other transaction from it in the past 3 blocks; a second
  // transfer inside that window reverts and still pays its fee. So every relayer is funded
  // in one transaction through Multicall3, after the deployer has been quiet for 3 blocks.
  const funder = createWalletClient({
    account: deployer,
    chain: monadTestnet,
    transport: http(settings.MONAD_RPC_URL),
  });
  const quietFrom = (await client.getBlock({ blockTag: 'latest' })).number;
  while ((await client.getBlock({ blockTag: 'finalized' })).number < quietFrom + 1n)
    await sleep(300);
  const calls: { target: Address; allowFailure: boolean; value: bigint; callData: Hex }[] =
    topUps.flatMap((value, w) =>
      value === 0n
        ? []
        : [
            {
              target: (relayers[w] as PrivateKeyAccount).address,
              allowFailure: false,
              value,
              callData: '0x',
            },
          ],
    );
  const request = {
    address: MULTICALL3,
    abi: multicall3Abi,
    functionName: 'aggregate3Value',
    args: [calls],
    value: totalTopUp,
    account: deployer,
    chain: monadTestnet,
  } as const;
  const gas = ((await client.estimateContractGas(request)) * 1075n) / 1000n;
  const hash = await funder.writeContract({ ...request, gas });
  const r = await client.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 60_000 });
  if (r.status !== 'success') throw new Error(`funding the relayers failed: ${hash}`);
  console.log(
    `funded ${String(calls.length)} wallets with ${formatEther(totalTopUp)} MON in one transaction`,
  );
  // Reserve rule: a wallet's in-flight gas budget uses its balance from three blocks earlier.
  while ((await client.getBlock({ blockTag: 'finalized' })).number < r.blockNumber + 3n)
    await sleep(300);
}

// ---------- sign every transaction up front ----------

const startNonces = await Promise.all(
  relayers.map((r) => client.getTransactionCount({ address: r.address, blockTag: 'latest' })),
);
const nonces = new NonceAllocator(Object.fromEntries(startNonces.map((n, w) => [String(w), n])));

type Rec = TxRecord & {
  walletIndex: number;
  order: number;
  copy: number;
  raw: Hex;
  endpoint?: string;
  error?: string;
  note?: string;
  resends: number;
  poolStatus?: string;
  finalizedApprox?: boolean;
};
const records: Rec[] = [];
for (const intent of intents) {
  const relayer = relayers[intent.wallet] as PrivateKeyAccount;
  const nonce = nonces.next(String(intent.wallet));
  const raw = await relayer.signTransaction({
    chainId: monadTestnet.id,
    type: 'eip1559',
    to: intent.to,
    data: intent.data,
    gas: gasLimit,
    nonce,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: priorityFee,
    value: 0n,
  });
  records.push({
    hash: keccak256(raw),
    wallet: relayer.address,
    walletIndex: intent.wallet,
    nonce,
    order: intent.order,
    copy: intent.copy,
    raw,
    sentAt: 0,
    attempts: 0,
    gasLimit,
    status: 'missing',
    resends: 0,
  });
}
const byHash = new Map(records.map((r) => [r.hash.toLowerCase(), r]));

// ---------- follow block stages ----------

const tracker = new StageTracker();
let lastProcessed: number | undefined;
let processing = Promise.resolve();
let socketDrops = 0;
let done = false;

async function readReceipts(
  blockNumber: number,
): Promise<{ transactionHash: string; status: string; gasUsed: string }[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const receipts = await rpc<
        { transactionHash: string; status: string; gasUsed: string }[] | null
      >(READ_URL, 'eth_getBlockReceipts', [toHex(blockNumber)]);
      if (receipts) return receipts;
    } catch (e) {
      if ((e instanceof RpcError && e.kind === 'rpc') || attempt >= 20) throw e;
    }
    if (attempt >= 20) throw new Error(`no receipts for block ${String(blockNumber)}`);
    await sleep(100 * attempt);
  }
}

async function processBlock(blockNumber: number, approx: boolean) {
  const receipts = await readReceipts(blockNumber);
  for (const receipt of receipts) {
    const rec = byHash.get(receipt.transactionHash.toLowerCase());
    if (!rec || rec.block !== undefined) continue;
    const stages = tracker.stagesOf(blockNumber);
    rec.block = blockNumber;
    rec.status = receipt.status === '0x1' ? 'success' : 'reverted';
    rec.gasUsed = BigInt(receipt.gasUsed);
    rec.proposedAt = stages?.Proposed;
    rec.votedAt = stages?.Voted;
    rec.finalizedAt = stages?.Finalized ?? Date.now();
    if (approx || stages?.Finalized === undefined) rec.finalizedApprox = true;
  }
}

function onFinalized(blockNumber: number) {
  if (lastProcessed === undefined) {
    lastProcessed = blockNumber; // nothing of ours is in this block or earlier: nothing has been sent yet
    return;
  }
  // A dropped socket can skip heads; skipped blocks are read too, with approximate times.
  for (let n = lastProcessed + 1; n <= blockNumber; n++) {
    const approx = n < blockNumber;
    processing = processing
      .then(() => processBlock(n, approx))
      .catch((e: unknown) => {
        console.error(`block ${String(n)}: ${e instanceof Error ? e.message : String(e)}`);
      });
  }
  lastProcessed = Math.max(lastProcessed, blockNumber);
}

function openSocket(): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(settings.MONAD_WS_URL);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_subscribe',
          params: ['monadNewHeads'],
        }),
      );
    };
    ws.onmessage = (event: MessageEvent) => {
      const at = Date.now();
      let message: {
        params?: { result?: { number: string; blockId: string; commitState: string } };
      };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      const head = message.params?.result;
      if (!head) return;
      const number = Number.parseInt(head.number, 16);
      tracker.observe(number, head.blockId, head.commitState, at);
      if (head.commitState === 'Finalized') {
        onFinalized(number);
        resolve();
      }
    };
    ws.onerror = () => {
      // onclose follows; reconnecting is handled there
    };
    ws.onclose = () => {
      if (done) return;
      socketDrops++;
      setTimeout(() => {
        void openSocket();
      }, 250);
    };
    sockets.push(ws);
  });
}
const sockets: WebSocket[] = [];
await openSocket();

// ---------- send ----------

const sendPacer = new Pacer(ENDPOINTS.map((e) => e.sendsPerSecond));
const endpointPacers = ENDPOINTS.map((e) => new Pacer([e.sendsPerSecond]));
const t0 = Date.now();
const ALREADY_IN = /already known|known transaction|already imported|nonce too low/i;

async function send(rec: Rec, isResend: boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const pinned = policy === 'ordered' ? rec.walletIndex % ENDPOINTS.length : undefined;
    const slot =
      pinned === undefined
        ? sendPacer.take(Date.now() - t0)
        : { index: pinned, at: (endpointPacers[pinned] as Pacer).take(Date.now() - t0).at };
    await sleep(slot.at - (Date.now() - t0));
    const endpoint = ENDPOINTS[slot.index] ?? ENDPOINTS[0];
    if (!isResend && attempt === 1) rec.sentAt = Date.now();
    rec.attempts = (rec.attempts ?? 0) + 1;
    try {
      await rpc<Hex>(endpoint.url, 'eth_sendRawTransaction', [rec.raw], 5_000);
      rec.acceptedAt ??= Date.now();
      rec.endpoint = new URL(endpoint.url).host;
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RpcError && e.kind === 'rpc') {
        if (ALREADY_IN.test(message)) {
          rec.acceptedAt ??= Date.now();
          rec.note = message;
        } else rec.error = message;
        return;
      }
      if (attempt >= 6) {
        rec.error = message;
        return;
      }
      await sleep(150 * attempt);
    }
  }
}

// A transaction not in a finalized block 5 s after acceptance is checked in the pool and re-sent if the pool has lost it.
const poolUrl = ENDPOINTS[0].url;
const stuckCheck = setInterval(() => {
  const now = Date.now();
  const stuck = records
    .filter(
      (r) =>
        r.acceptedAt !== undefined &&
        r.block === undefined &&
        r.error === undefined &&
        now - r.acceptedAt > 5_000,
    )
    .slice(0, 8);
  for (const rec of stuck) {
    rpc<unknown>(poolUrl, 'txpool_statusByHash', [rec.hash])
      .then((status) => {
        rec.poolStatus = JSON.stringify(status).slice(0, 200);
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        rec.poolStatus = message.slice(0, 200);
        if (/unknown tx hash/i.test(message)) {
          rec.resends++;
          void send(rec, true);
        }
      });
  }
}, 2_000);

if (policy === 'spread') await Promise.all(records.map((r) => send(r, false)));
else
  await Promise.all(
    relayers.map(async (_, w) => {
      // Records were created in nonce order, so each wallet's list is already ascending.
      for (const rec of records.filter((r) => r.walletIndex === w)) await send(rec, false);
    }),
  );
const sendsDone = Date.now();
console.log(`all sends returned after ${String(sendsDone - t0)} ms; waiting for Finalized`);

const settledOrFailed = () => records.every((r) => r.block !== undefined || r.error !== undefined);
while (!settledOrFailed() && Date.now() - sendsDone < 120_000) await sleep(250);
await processing;
done = true;
clearInterval(stuckCheck);
for (const ws of sockets) ws.close();

// ---------- results ----------

const summary = summarise(records, chargedPrice);
const perOrderPaid = new Map<number, number>();
for (const r of records)
  if (r.status === 'success') perOrderPaid.set(r.order, (perOrderPaid.get(r.order) ?? 0) + 1);
const duplicates =
  scenario === 'duplicates'
    ? {
        ordersPaidExactlyOnce: [...Array(count).keys()].filter((i) => perOrderPaid.get(i) === 1)
          .length,
        ordersPaidTwice: [...perOrderPaid.values()].filter((n) => n > 1).length,
      }
    : undefined;
const problems = {
  sendErrors: records.filter((r) => r.error !== undefined).length,
  resends: records.reduce((a, r) => a + r.resends, 0),
  retries: records.reduce((a, r) => a + Math.max(0, (r.attempts ?? 0) - 1 - r.resends), 0),
  approximateTimes: records.filter((r) => r.finalizedApprox === true).length,
  socketDrops,
};

mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(
  resultFile,
  toJson({
    label,
    arm,
    scenario,
    set: setName,
    wallets: walletCount,
    count,
    policy,
    at: new Date(t0).toISOString(),
    executionGas,
    gasLimit,
    baseFeeGwei: formatGwei(baseFee),
    maxFeeGwei: formatGwei(maxFee),
    endpoints: ENDPOINTS.map((e) => ({
      host: new URL(e.url).host,
      sendsPerSecond: e.sendsPerSecond,
    })),
    summary,
    duplicates,
    problems,
    // The signed transactions stay out of the results file; the hashes identify them.
    records: records.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'raw'))),
  }),
);

const ms = (v: number | null) => (v === null ? 'n/a' : `${String(v)} ms`);
console.log(`
${label}  (${arm}, ${scenario}, ${setName}, ${String(walletCount)} wallets, ${policy} sending)
  transactions        ${String(summary.count)}: ${String(summary.succeeded)} paid, ${String(summary.reverted)} refused, ${String(summary.missing)} missing
  first send → last finalized   ${ms(summary.wallClockMs)}
  sending alone                 ${ms(summary.sendWindowMs)}
  send → finalized    p50 ${ms(summary.p50Ms)}, p95 ${ms(summary.p95Ms)}
  blocks used         ${String(summary.blocksUsed)} (max ${String(summary.maxPerBlock)} in one block)
  execution gas       ${String(executionGas)} (limit ${String(gasLimit)})
  MON spent           ${summary.monSpent.toFixed(4)}
  problems            ${JSON.stringify(problems)}${duplicates ? `\n  duplicates          ${JSON.stringify(duplicates)}` : ''}
  written to          results/run-${label}.json`);
process.exit(0);
