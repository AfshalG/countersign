import { serve } from '@hono/node-server';
import { formatEther, type Address } from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { deployments, ENDPOINTS } from '@countersign/chain';
import { IDENTITY_REGISTRY_TESTNET, REASONS, type Reason } from '@countersign/shared';
import { createApp } from './app.js';
import { TestChecker } from './checker.js';
import { FinalityTracker } from './chain/finality.js';
import { OrderIndexer } from './chain/indexer.js';
import { MonadClient } from './chain/monad.js';
import { connect } from './db/client.js';
import { Store } from './db/store.js';
import { RelayerPool } from './relay/pool.js';
import { WalletFunder } from './demo/funder.js';
import { AgentDirectory } from './agents/identity.js';
import { judgeMode, loadSettings } from './settings.js';
import { Workers } from './workers.js';

const settings = loadSettings();
const chainId = settings.MONAD_CHAIN_ID;
const judge = judgeMode(settings); // throws at start if only one of its keys is set

/**
 * Until the checker service exists (Slice 10) the stand-in checker releases every payment, except
 * that a request whose document says `{ "testHold": "<reason>" }` is held with that reason, so a
 * hold can be exercised on testnet.
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
const pool = new RelayerPool({
  keys: relayers,
  store,
  sender: monad,
  chainId,
  endpoints: ENDPOINTS.length,
  stallMs: 3_000, // a payment is final in about 1.2 s at p95 (Spike 3)
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
const catchUp = () => {
  indexer.catchUp().catch((e: unknown) => {
    console.error(`indexer catch-up: ${e instanceof Error ? e.message : String(e)}`);
  });
};
const checker = new TestChecker(settings.TEST_CHECKER_PRIVATE_KEY, chainId, (input) =>
  testHold(input.request.document),
);
const CHECKER_TIMEOUT_MS = 2_000;
const workers = new Workers({
  store,
  chain: monad,
  checker,
  pool,
  chainId,
  checkerTimeoutMs: CHECKER_TIMEOUT_MS,
  leaseMs: 30_000,
  checkConcurrency: 8,
  sendConcurrency: 8,
  tickMs: 50,
});

await pool.start();
const recovered = await workers.recover();
console.log(
  `recovered: ${String(recovered.settled)} settled from receipts, ${String(recovered.resent)} re-sent`,
);
workers.start();
// Accounts behind (just registered, or the gateway was down) are brought up to date in windows.
catchUp();
const catchUpTimer = setInterval(catchUp, 15_000);
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
  checkerKey: privateKeyToAddress(settings.TEST_CHECKER_PRIVATE_KEY),
  perDay: judge.perDay,
  agentPrivateKey: judge.agentKey,
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

const app = createApp({
  agents,
  ...(demo ? { demo } : {}),
  proposals: owner,
  pause: owner,
  store,
  chain: monad,
  checker,
  chainId,
  checkerTimeoutMs: CHECKER_TIMEOUT_MS,
  indexing: { latestFinalized: () => monad.latestFinalized(), catchUp: () => indexer.catchUp() },
  publicUrl: settings.PUBLIC_URL,
  token: settings.GATEWAY_SERVICE_TOKEN,
  health: async () => ({
    chainId,
    finality: monad.socketState(),
    relayers: await Promise.all(
      pool.relayers.map(async (address: Address) => ({
        address,
        mon: formatEther(await monad.balanceOf(address)),
      })),
    ),
    moves: pool.moves().length,
    // Wallets a node refused for low balance; their payments wait until they are topped up.
    starved: pool.starved(),
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
