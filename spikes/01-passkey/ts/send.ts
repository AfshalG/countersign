/**
 * Sends a software-signed fixture to the testnet probe.
 * Run from the repo root .env: pnpm --filter @countersign/spike-01-passkey send <full|native|solidity> [tamper]
 */
import { readFileSync } from 'node:fs';
import vectors from '../test/fixtures/vectors.json' with { type: 'json' };
import { recordOnMonad, settingsFromEnv } from './record.js';
import { parseRecordRequest } from './request.js';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const deployed = JSON.parse(readFileSync(new URL('../deployed.json', import.meta.url), 'utf8')) as {
  probe: `0x${string}` | null;
};
if (!deployed.probe) throw new Error('No probe address in deployed.json. Deploy first.');

const mode = process.argv[2] ?? 'full';
const tamper = process.argv[3] === 'tamper';
// Tampering flips the last byte of the challenge: the signature no longer matches it.
const challenge = tamper
  ? `${vectors.challenge.slice(0, -2)}${vectors.challenge.endsWith('00') ? '01' : '00'}`
  : vectors.challenge;

const req = parseRecordRequest({
  challenge,
  auth: vectors.valid,
  qx: vectors.qx,
  qy: vectors.qy,
  mode,
});
const result = await recordOnMonad(settingsFromEnv(process.env), deployed.probe, req);
console.log(
  JSON.stringify(
    { mode, tamper, ...result, checkGas: String(result.checkGas), txGas: String(result.txGas) },
    null,
    2,
  ),
);
