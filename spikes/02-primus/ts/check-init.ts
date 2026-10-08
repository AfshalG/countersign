/** Spike 2, step 1: does the Primus SDK start on Node 24 (WebAssembly mode) with our keys? */
import { PrimusCoreTLS } from '@primuslabs/zktls-core-sdk';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const appId = process.env.PRIMUS_APP_ID;
const appSecret = process.env.PRIMUS_APP_SECRET;
if (!appId || !appSecret)
  throw new Error('PRIMUS_APP_ID and PRIMUS_APP_SECRET must be set in .env');

// The SDK keeps connections open; fail loudly instead of hanging.
setTimeout(() => {
  console.error('init did not finish within 60 s');
  process.exit(1);
}, 60_000).unref();

const started = Date.now();
const zkTLS = new PrimusCoreTLS();
const result: unknown = await zkTLS.init(appId, appSecret, 'wasm');
console.log(
  JSON.stringify({ node: process.version, initResult: result, ms: Date.now() - started }),
);
process.exit(0);
