import { serve } from '@hono/node-server';
import { formatEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployments, ENDPOINTS } from '@countersign/chain';
import { IDENTITY_REGISTRY_TESTNET, REASONS, type Reason } from '@countersign/shared';
import { createApp } from './app.js';
import { TestChecker, type Checker } from './checker.js';
import { RemoteChecker, orderFacts } from './checker-remote.js';
import { FinalityTracker } from './chain/finality.js';
import { OrderIndexer } from './chain/indexer.js';
import { MonadClient } from './chain/monad.js';
import { connect } from './db/client.js';
import { Store } from './db/store.js';
import { RelayerPool } from './relay/pool.js';
import { WalletFunder } from './demo/funder.js';
import { AgentDirectory } from './agents/identity.js';
import { DecisionRecorder } from './decisions.js';
import { checkerMode, judgeMode, loadSettings, primusKeys, whatsappMode } from './settings.js';
import { supplierNameOf } from './suppliers.js';
import { WhatsAppApi } from './notify/whatsapp-api.js';
import { WhatsAppNotifier } from './notify/whatsapp.js';
import { Workers } from './workers.js';
import { KALIBRE_FILE, WebsiteProofs } from './proofs/website.js';
import { KALIBRE } from './demo/plan.js';
import { PrimusProver, registryRecorder } from './proofs/primus.js';

const settings = loadSettings();
const chainId = settings.MONAD_CHAIN_ID;
const judge = judgeMode(settings); // throws at start if only one of its keys is set
const checking = checkerMode(settings); // likewise for the checker service's three settings

/**
 * Without the checker service (Slice 10) the stand-in checker releases every payment, except that
 * a request whose document says `{ "testHold": "<reason>" }` is held with that reason.
 */
function testHold(document: unknown): Reason | undefined {
  if (typeof document !== 'object' || document === null || !('testHold' in document))
    return undefined;
  const reason = document.testHold;
  return (REASONS as readonly unknown[]).includes(reason) ? (reason as Reason) : 'checker_unsure';
}

const database = await connect(settings.DATABASE_URL);
const store = new Store(database.db);
const relayers = settings.RELAYER_PRIVATE_KEYS;
const monad = new MonadClient(
  ENDPOINTS,
  settings.MONAD_WS_URL,
  privateKeyToAccount(relayers[0] as `0x${string}`).address,
);
let finalityProbe: () => boolean = () => false;
const pool = new RelayerPool({
  keys: relayers,
  store,
  sender: monad,
  chainId,
  endpoints: ENDPOINTS.length,
  // A payment is final in about 1.2 s at p95 (Spike 3), but in a run of 200 a wallet's oldest
  // transaction can wait longer behind the burst; 3 s made lanes move for nothing (Slice 16).
  stallMs: 6_000,
  // Assigned once the tracker exists (it needs the pool).
  finalityBehind: () => finalityProbe(),
  tickMs: 25,
  onRefused: (hash, error) => {
    console.error(`endpoint refused ${hash}: ${error}`);
  },
});
const indexer = new OrderIndexer({ store, source: monad });
const tracker = new FinalityTracker({
  store,
  receipts: monad,
  pool,
  onFinalizedBlock: (blockNumber, logs) => indexer.onBlock(blockNumber, logs),
});
finalityProbe = () => tracker.behind();
const catchUp = () => {
  indexer.catchUp().catch((e: unknown) => {
    console.error(`indexer catch-up: ${e instanceof Error ? e.message : String(e)}`);
  });
};
const checker: Checker =
  checking.kind === 'remote'
    ? new RemoteChecker({
        url: checking.url,
        token: checking.token,
        facts: (row) => orderFacts({ store }, row),
      })
    : new TestChecker(checking.key, chainId, (input) => testHold(input.request.document));
// Suppliers' websites (Slice 15): what a site lists, proven by Primus and recorded on Monad, shown
// on each proposal's approval page and named by the supplier record the owner signs. Without
// Primus keys every check says it could not be proven, and the owner confirms by hand.
const primus = primusKeys(settings);
const websites = new WebsiteProofs({
  store,
  prover: primus
    ? new PrimusProver({ ...primus, recipient: deployments.supplierProofs })
    : undefined,
  recorder: registryRecorder(
    { store, pool, finality: tracker, chain: monad },
    deployments.supplierProofs,
  ),
  onFile: async (account, id) => (await monad.supplierOf(account, id)) !== null,
});
store.onProposal((proposal) => {
  void websites.checkProposal(proposal).catch((e: unknown) => {
    console.error(`website check ${proposal.id}: ${e instanceof Error ? e.message : String(e)}`);
  });
});
// A changed-address hold shows what the supplier's website on file lists: start that check at once,
// so the owner's page has it when they open it (part 2).
store.onChange((change) => {
  if (change.to !== 'held' || change.reason !== 'address_mismatch') return;
  void (async () => {
    const row = await store.get(change.requestId);
    const order = row ? await store.orderByVault(row.vault) : undefined;
    const url =
      row && order
        ? await websites.siteOnFile(row.account as Address, order.supplierId as `0x${string}`)
        : null;
    if (url) await websites.check(url);
  })().catch((e: unknown) => {
    console.error(
      `hold website ${change.requestId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
});
console.log(`website proofs ${primus ? 'on' : 'off (no Primus keys)'}`);

const CHECKER_TIMEOUT_MS = 2_000;
// Slice 18: checker holds and owner refusals written on Monad with their evidence hashes.
const decisions = new DecisionRecorder({
  store,
  pool,
  enabled: settings.RECORD_DECISIONS !== 'false',
});
const workers = new Workers({
  store,
  chain: monad,
  checker,
  pool,
  chainId,
  checkerTimeoutMs: CHECKER_TIMEOUT_MS,
  websites,
  decisions,
  leaseMs: 30_000,
  checkConcurrency: settings.CHECK_CONCURRENCY ?? 8,
  sendConcurrency: 8,
  tickMs: 50,
});

await pool.start();
const recovered = await workers.recover();
// Decisions kept but never signed (a restart, or recording off then); again every minute.
await decisions.resume();
setInterval(() => void decisions.resume(), 60_000).unref();
console.log(
  `recovered: ${String(recovered.settled)} settled from receipts, ${String(recovered.resent)} re-sent`,
);
workers.start();
// Accounts behind (just registered, or the gateway was down) are brought up to date in windows.
catchUp();
const catchUpTimer = setInterval(catchUp, 15_000);
// Approved suppliers' websites, checked again once a day (Slice 15, D21): hourly, each site whose
// last check is over a day old.
const recheckSites = () => {
  websites.recheck().catch((e: unknown) => {
    console.error(`website recheck: ${e instanceof Error ? e.message : String(e)}`);
  });
};
const recheckTimer = setInterval(recheckSites, 3_600_000);
setTimeout(recheckSites, 60_000).unref();
const heads = monad.subscribeHeads((head) => {
  void tracker.onHead(head);
});
tracker.startPolling(1_000);

// Judge mode: an account for a new passkey, set up with that passkey (Slice 9 part 4).
const demo = judge && {
  store,
  chain: monad,
  pool,
  finality: tracker,
  funder: new WalletFunder(judge.funderKey, monad, chainId),
  chainId,
  factory: deployments.accountFactory,
  agentKey: judge.agent,
  checkerKey: checking.address,
  perDay: judge.perDay,
  agentPrivateKey: judge.agentKey,
  kalibreProof: () => websites.freshListing(KALIBRE_FILE, KALIBRE.payTo),
};

// The owner's passkey actions: approving proposals (Slice 9 part 2) and the stop button (part 3).
const owner = {
  store,
  chain: monad,
  pool,
  finality: tracker,
  chainId,
  publicUrl: settings.PUBLIC_URL,
};

// ERC-8004 agents named on payments (Slice 19), each re-read from the registry at start.
const agents = new AgentDirectory(monad, IDENTITY_REGISTRY_TESTNET, chainId);
await agents.load(store);
console.log(
  `agents named on payments: ${
    agents
      .list()
      .map((a) => `#${a.agentId}`)
      .join(', ') || 'none'
  }`,
);

// WhatsApp (Slice 14, D31): held payments and proposals reach the people connected to the account,
// with the approval link. Sending never holds up a payment: it runs after the change is stored.
const wa = whatsappMode(settings);
const whatsapp = wa
  ? new WhatsAppNotifier({
      store,
      api: new WhatsAppApi({ phoneNumberId: wa.phoneNumberId, accessToken: wa.accessToken }),
      chain: monad,
      chainId,
      publicUrl: settings.PUBLIC_URL.replace(/\/$/, ''),
      number: wa.number,
      ...(wa.template ? { template: wa.template } : {}),
      supplierName: (account, vault) => supplierNameOf(store, account, vault),
    })
  : undefined;
if (whatsapp) {
  const failed = (what: string) => (e: unknown) => {
    console.error(`whatsapp ${what}: ${e instanceof Error ? e.message : String(e)}`);
  };
  store.onChange((change) => {
    if (change.to === 'held') void whatsapp.held(change.requestId).catch(failed('held'));
  });
  store.onProposal((proposal) => {
    void whatsapp.proposed(proposal).catch(failed('proposal'));
  });
}
console.log(
  `whatsapp ${wa ? `on (${wa.template ? `template ${wa.template.name}` : 'no template: only within 24 hours'})` : 'off'}`,
);

const app = createApp({
  agents,
  websites,
  ...(demo ? { demo } : {}),
  proposals: owner,
  pause: owner,
  ...(whatsapp && wa
    ? { whatsapp: { notifier: whatsapp, verifyToken: wa.verifyToken, appSecret: wa.appSecret } }
    : {}),
  store,
  chain: monad,
  checker,
  decisions,
  // Advice on bank-transfer invoices (Slice 17): only the checker service gives it.
  ...(checker instanceof RemoteChecker ? { advisor: checker } : {}),
  chainId,
  checkerTimeoutMs: CHECKER_TIMEOUT_MS,
  indexing: { latestFinalized: () => monad.latestFinalized(), catchUp: () => indexer.catchUp() },
  publicUrl: settings.PUBLIC_URL,
  token: settings.GATEWAY_SERVICE_TOKEN,
  health: async () => ({
    chainId,
    finality: { ...monad.socketState(), behindBlocks: tracker.lag() },
    relayers: await Promise.all(
      pool.relayers.map(async (address: Address) => ({
        address,
        mon: formatEther(await monad.balanceOf(address)),
      })),
    ),
    moves: pool.moves().length,
    // Slice 16: each wallet's lane (a stuck one shows its head nonce and why).
    lanes: pool.lanesView(),
    // Wallets a node refused for low balance; their payments wait until they are topped up.
    starved: pool.starved(),
    // Which checker decides: the service (Slice 10) or the stand-in.
    checker: { kind: checking.kind, signer: checking.address },
    // WhatsApp (Slice 14): on or off, and the template used outside the 24-hour window.
    whatsapp: wa ? { template: wa.template?.name ?? null } : null,
    // Suppliers' website proofs (Slice 15): Primus on or off, and the registry on Monad.
    proofs: { primus: primus !== undefined, registry: deployments.supplierProofs },
  }),
});
const server = serve({ fetch: app.fetch, port: settings.PORT }, (info) => {
  console.log(
    `gateway listening on ${String(info.port)} with ${String(relayers.length)} relayers; judge mode ${demo ? `on (${String(demo.perDay)} accounts a day)` : 'off'}`,
  );
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping`);
  workers.stop();
  pool.stop();
  tracker.stopPolling();
  clearInterval(catchUpTimer);
  clearInterval(recheckTimer);
  heads.close();
  server.close(() => {
    database.pool
      .end()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
