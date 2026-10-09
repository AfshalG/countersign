import { readFile } from 'node:fs/promises';

/**
 * llms.txt (https://llmstxt.org): what a coding agent reads when a developer says "integrate
 * Countersign". A short index (`/llms.txt`) and the guides in one file (`/llms-full.txt`), both
 * plain markdown. The guides are read from the repo, so they never drift from the docs.
 */

const REPO = 'https://github.com/AfshalG/countersign';
const RAW = 'https://raw.githubusercontent.com/AfshalG/countersign/development';
const SDK_TGZ = `${REPO}/releases/download/sdk-v0.3.0/countersign-sdk-0.3.0.tgz`;
const MCP_URL = 'https://countersign-mcp.vercel.app/api/mcp';

export function llmsTxt(publicUrl: string): string {
  return `# Countersign

> An account on Monad that sits between any AI agent and the money. The owner approves suppliers, their addresses and order amounts once, with a passkey; the agent then pays inside those rules with no click, and anything else is held for the owner with the reason and a link. The contract that holds the money enforces the rules. Monad testnet (chain 10143), USDC. MIT.

Three ways in, all to the same gateway (${publicUrl}):

- **SDK** (TypeScript, the agent's key signs locally): \`npm i ${SDK_TGZ}\`. A test account of your own, in one command: \`npx --package=${SDK_TGZ} countersign-test-account > .env\` (an agent key, a funded account with an open order, and a token for that account alone)
- **MCP server** (six tools: list_open_orders, check_invoice, pay_invoice, pay_invoices, payment_status, propose_order): ${MCP_URL}, with \`Authorization: Bearer <token>\`
- **Web API**: [reference](${publicUrl}/docs), [OpenAPI 3.1](${publicUrl}/openapi.json)

Key rules for an agent: a payment names an open order and the invoice's number, amount (a decimal string of USDC, e.g. "12.50", never a float) and payment address. The account pays only the supplier's address on file, within the order, each invoice once. A result is \`settled\`, \`held\` (tell the person the reason and give them the link; do not retry with another address or amount) or \`blocked\`. Sending the same invoice again is the same request, not a new payment (\`duplicate: true\`). An invoice paid by bank transfer gets advice, not a payment: \`check_invoice\` with \`bankTransfer: true\` and the invoice's text, or SDK \`advise()\` (\`match\`, \`mismatch\`: do not pay, or \`unsure\`). Each payment's record (\`GET /v1/payments/{id}/record\`, SDK \`record()\`) checks out against Monad with \`npx countersign-verify <file>\`.

## Docs

- [Developer quickstart](${RAW}/docs/developers/quickstart.md): the three ways in, what happens to a payment, statuses, invoice identity, limits
- [SDK guide](${RAW}/packages/sdk/README.md): install, every method, errors, amounts
- [API reference](${publicUrl}/docs): every route, generated from the gateway's validation schemas
- [Everything above in one file](${publicUrl}/llms-full.txt)

## Examples

- [Pay an invoice with the SDK](${RAW}/examples/pay-an-invoice/index.mjs): makes a test account, reads the supplier's invoice page and pays it (0.001 USDC), waiting until it is final
- [Connect Claude Code](${RAW}/examples/claude-code/README.md)

## Optional

- [Security model](${REPO}#security-model): what the contract enforces, each claim with a test or a transaction
- [Where your data goes](${REPO}#where-your-data-goes) and [the evidence](${RAW}/docs/evidence.md): every claim with its transaction, test or results file
- [Repository](${REPO})
`;
}

/** The guides, read from the repo once and kept. */
let guides: Promise<string> | undefined;

async function readGuides(): Promise<string> {
  const files = ['../../../../docs/developers/quickstart.md', '../../../../packages/sdk/README.md'];
  const texts = await Promise.all(files.map((f) => readFile(new URL(f, import.meta.url), 'utf8')));
  return texts.join('\n\n---\n\n');
}

export async function llmsFullTxt(publicUrl: string): Promise<string> {
  guides ??= readGuides().catch((e: unknown) => {
    guides = undefined; // try again on the next request
    throw e;
  });
  return `${llmsTxt(publicUrl)}\n---\n\n${await guides}\n`;
}
