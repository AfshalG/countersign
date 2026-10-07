/**
 * Spike 2: asks Primus (proxy-TLS) to attest a supplier's address file and
 * records the attestation as a test fixture.
 * Run: pnpm attest <label> [url]
 */
import { writeFileSync } from 'node:fs';
import { PrimusCoreTLS } from '@primuslabs/zktls-core-sdk';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const { PRIMUS_APP_ID, PRIMUS_APP_SECRET, DEPLOYER_ADDRESS } = process.env;
if (!PRIMUS_APP_ID || !PRIMUS_APP_SECRET)
  throw new Error('PRIMUS_APP_ID and PRIMUS_APP_SECRET must be set in .env');

const label = process.argv[2] ?? 'supplier';
const url =
  process.argv[3] ?? 'https://countersign-supplier-demo.vercel.app/.well-known/countersign.json';
// The recipient is who the attestation is for; the relayer wallet for now.
const recipient = DEPLOYER_ADDRESS ?? '0xf8a69BdB48aeae88136C7F9D87FeB2B24458C79B';

// The SDK keeps connections open; fail loudly instead of hanging.
setTimeout(() => {
  console.error('attestation did not finish within 120 s');
  process.exit(1);
}, 120_000).unref();

const zkTLS = new PrimusCoreTLS();
await zkTLS.init(PRIMUS_APP_ID, PRIMUS_APP_SECRET, 'wasm');

const request = { url, method: 'GET', header: {}, body: '' };
const responseResolves = [{ keyName: 'payTo', parsePath: '$.payTo' }];
const attRequest = zkTLS.generateRequestParams(request, responseResolves, recipient);
attRequest.setAttMode({ algorithmType: 'proxytls' });

const started = Date.now();
const attestation: unknown = await zkTLS.startAttestation(attRequest);
const ms = Date.now() - started;
const verified: unknown = zkTLS.verifyAttestation(attestation);

const out = new URL(`../test/fixtures/attestation-${label}.json`, import.meta.url);
writeFileSync(out, `${JSON.stringify(attestation, null, 2)}\n`);
console.log(JSON.stringify({ label, url, ms, sdkVerify: verified, saved: out.pathname }));
process.exit(0);
