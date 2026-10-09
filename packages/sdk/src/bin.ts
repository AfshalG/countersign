#!/usr/bin/env node
/**
 * Makes a Countersign test account for your own agent and prints it as .env lines:
 *
 *   npx countersign-test-account >> .env
 *   npx countersign-test-account --gateway http://localhost:8787
 *
 * The keys are made here and printed once; nothing else keeps them. Testnet only.
 */
import { createTestAccount } from './test-account.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: countersign-test-account [--gateway <url>]  (prints .env lines)');
  process.exit(0);
}
const at = args.indexOf('--gateway');
const gateway = at === -1 ? undefined : args[at + 1];

console.error('Creating a testnet account for your agent (about ten seconds)…');
try {
  const t = await createTestAccount(gateway === undefined ? {} : { gateway });
  console.error(
    `Ready: ${t.account}, with ${t.order?.amountUsdc ?? '0.005'} USDC to pay ${t.order?.supplier ?? 'the demo supplier'} at ${t.order?.payTo ?? ''}`,
  );
  console.log(
    [
      '# Countersign test account (Monad testnet). Keep these out of git.',
      `COUNTERSIGN_GATEWAY=${t.gateway}`,
      `COUNTERSIGN_ACCOUNT=${t.account}`,
      `COUNTERSIGN_TOKEN=${t.token}`,
      `COUNTERSIGN_AGENT_KEY=${t.agentKey}`,
      '# The owner, standing in for a passkey (test accounts only): decides holds with decide()',
      `COUNTERSIGN_OWNER_KEY=${t.ownerKey}`,
    ].join('\n'),
  );
} catch (e) {
  console.error(`Could not create the account: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
