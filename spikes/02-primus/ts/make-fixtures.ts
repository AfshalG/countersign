/**
 * Writes each recorded attestation as ABI-encoded bytes, so the Foundry tests
 * decode exactly the struct the contract receives. Run: pnpm fixtures
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encodeAbiParameters, getAbiItem } from 'viem';
import { primusAbi } from './abi.js';
import { toSolidityAttestation } from './encode.js';

const dir = new URL('../test/fixtures/', import.meta.url);
const verify = getAbiItem({ abi: primusAbi, name: 'verifyAttestation' });
for (const file of readdirSync(dir).filter((f) => /^attestation-.*\.json$/.test(f))) {
  const att = toSolidityAttestation(JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
  const hex = encodeAbiParameters(verify.inputs, [att]);
  const out = new URL(file.replace(/\.json$/, '.abi'), dir);
  writeFileSync(out, hex); // no trailing newline: vm.parseBytes rejects it
  console.log(`wrote ${out.pathname}`);
}
