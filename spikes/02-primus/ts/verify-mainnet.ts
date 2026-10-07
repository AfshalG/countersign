/**
 * Spike 2: checks a recorded attestation against Primus's own verifier on
 * Monad mainnet with a read-only call (no transaction, no cost), then checks
 * that a copy with one changed character is rejected.
 * Run: pnpm verify:mainnet [label]
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { monad } from 'viem/chains';
import { primusAbi } from './abi.js';
import { PRIMUS_MAINNET_VERIFIER, toSolidityAttestation } from './encode.js';

const label = process.argv[2] ?? 'supplier';
const raw: unknown = JSON.parse(
  readFileSync(new URL(`../test/fixtures/attestation-${label}.json`, import.meta.url), 'utf8'),
);
const att = toSolidityAttestation(raw);
const client = createPublicClient({ chain: monad, transport: http('https://rpc.monad.xyz') });

async function check(name: string, attestation: typeof att) {
  try {
    await client.readContract({
      address: PRIMUS_MAINNET_VERIFIER,
      abi: primusAbi,
      functionName: 'verifyAttestation',
      args: [attestation],
    });
    return { name, accepted: true };
  } catch (error) {
    const reason =
      error instanceof Error
        ? (error.message.split('\n').find((l) => /reverted|reason/i.test(l)) ??
          error.message.split('\n')[0])
        : String(error);
    return { name, accepted: false, reason };
  }
}

const doctored = { ...att, data: att.data.replace(/.(?="}$)/, (c) => (c === 'c' ? 'd' : 'c')) };
console.log(
  JSON.stringify(
    [await check('real attestation', att), await check('one character changed', doctored)],
    null,
    2,
  ),
);
