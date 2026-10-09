#!/usr/bin/env node
/**
 * Checks a Countersign payment record against Monad, without trusting Countersign (Slice 18):
 *
 *   npx countersign-verify countersign-record-0x….json
 *   npx countersign-verify record.json --rpc https://testnet-rpc.monad.xyz
 *
 * Prints each check, and exits 1 if any fails.
 */
import { readFile } from 'node:fs/promises';
import { verifyRecord, type PaymentRecord } from './verify.js';

const args = process.argv.slice(2);
const at = args.indexOf('--rpc');
const rpcUrl = at === -1 ? undefined : args[at + 1];
// The file: the first argument that is neither a flag nor the --rpc value.
const file = args.find((a, i) => !a.startsWith('-') && (at === -1 || i !== at + 1));
if (!file || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: countersign-verify <record.json> [--rpc <Monad RPC URL>]');
  process.exit(file ? 0 : 2);
}

try {
  const record = JSON.parse(await readFile(file, 'utf8')) as PaymentRecord;
  const result = await verifyRecord(record, rpcUrl === undefined ? {} : { rpcUrl });
  for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check}: ${c.detail}`);
  console.log(result.ok ? 'The record matches Monad.' : 'The record does NOT match Monad.');
  process.exit(result.ok ? 0 : 1);
} catch (e) {
  console.error(`Could not verify ${file}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
