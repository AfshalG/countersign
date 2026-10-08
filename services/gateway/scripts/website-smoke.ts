/**
 * Slice 15 live: a new test account (as a developer makes one) proposes the demo site's three
 * quotes, and each approval page says what the supplier's own website lists, proven by Primus and
 * recorded on Monad. Kalibre Studio's quote (on file) is listed; the poisoned quote is not;
 * Northwind Prints (new to the account) is listed, and approving it with the test owner key puts a
 * supplier record on chain that names the proof. About 0.2 MON, three Primus proofs at most.
 *
 *   pnpm --filter @countersign/gateway website-smoke [gateway URL]
 */
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { chain, countersignAccountAbi } from '@countersign/chain';
import { supplierId, supplierSlug } from '@countersign/shared';
import { Countersign } from '@countersign/sdk';
import { createTestAccount, TestOwner } from '@countersign/sdk/test-account';

const gateway = process.argv[2] ?? 'https://gateway-production-e17a.up.railway.app';
const KALIBRE_SITE = 'https://countersign-supplier-demo.vercel.app';
const NORTHWIND_SITE = 'https://northwind-prints-demo.vercel.app';

type Quote = {
  number: string;
  from: { name: string; website?: string };
  totalUsdc: string;
  payTo: Address;
  case: { expect: { website?: string } };
};
type Proof = {
  status: string;
  site: string | null;
  source: string;
  text: string;
  proofHash: string | null;
  txHash: string | null;
};
type Approval = {
  summary: { websiteProof: Proof | null; changesAddress: boolean };
  actions: Record<string, { challenge: Hex } | undefined>;
};

let t = Date.now();
const me = await createTestAccount({ gateway });
console.log(`test account ${me.account} ready in ${String(Date.now() - t)} ms`);
const cs = new Countersign({
  gateway,
  token: me.token,
  account: me.account,
  agentKey: me.agentKey,
});
const owner = TestOwner.fromPrivateKey(me.ownerKey);
const run = Date.now().toString(36).slice(-6);

async function approval(id: string): Promise<Approval> {
  const res = await fetch(`${gateway}/v1/approvals/${id}`);
  if (!res.ok) throw new Error(`approval ${id}: ${String(res.status)}`);
  return (await res.json()) as Approval;
}

let failed = false;
const proposals: Record<string, string> = {};
for (const [id, site] of [
  ['q-2210', KALIBRE_SITE],
  ['q-2211', KALIBRE_SITE],
  ['nw-q-301', NORTHWIND_SITE],
] as const) {
  const page = `${site}/quotes/${id}?account=${me.account}&run=${run}`;
  const quote = (await (await fetch(`${page}&format=json`)).json()) as Quote;
  const text = await (await fetch(page)).text();
  t = Date.now();
  const p = await cs.proposeOrder({
    supplier: {
      name: quote.from.name,
      payTo: quote.payTo,
      ...(quote.from.website ? { website: quote.from.website } : {}),
    },
    amount: quote.totalUsdc,
    expiry: Math.floor(Date.now() / 1000) + 14 * 86_400,
    document: text,
  });
  proposals[id] = p.id;
  let view = await approval(p.id);
  while (view.summary.websiteProof?.status === 'checking' && Date.now() - t < 70_000) {
    await new Promise((r) => setTimeout(r, 1_000));
    view = await approval(p.id);
  }
  const proof = view.summary.websiteProof;
  const ok = proof?.status === quote.case.expect.website;
  failed ||= !ok;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${id} (${quote.from.name}): ${proof?.status ?? 'no check'} via ${proof?.source ?? '?'} in ${String(Date.now() - t)} ms, expected ${String(quote.case.expect.website)}`,
  );
  console.log(`     ${proof?.text ?? ''}`);
  if (proof?.txHash)
    console.log(`     recorded: https://testnet.monadexplorer.com/tx/${proof.txHash}`);
}

// Approve Northwind with the owner key: the supplier record names the proof.
const nw = proposals['nw-q-301'];
if (nw) {
  const view = await approval(nw);
  const sign = (key: string) => {
    const a = view.actions[key];
    if (!a) throw new Error(`${key} not offered`);
    return owner.sign(a.challenge);
  };
  t = Date.now();
  const res = await fetch(`${gateway}/v1/approvals/${nw}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'approve',
      assertions: { set_supplier: sign('set_supplier'), approve_order: sign('approve_order') },
    }),
  });
  const body = (await res.json()) as { status?: string; error?: string; message?: string };
  console.log(
    `approved Northwind: ${String(res.status)} ${body.status ?? `${body.error ?? ''} ${body.message ?? ''}`} in ${String(Date.now() - t)} ms`,
  );
  const reader = createPublicClient({ chain, transport: http() });
  const record = await reader.readContract({
    address: me.account,
    abi: countersignAccountAbi,
    functionName: 'supplier',
    args: [supplierId(supplierSlug('Northwind Prints'))],
  });
  const named = record.proofHash === view.summary.websiteProof?.proofHash;
  failed ||= !named;
  console.log(
    `${named ? 'ok  ' : 'FAIL'} Northwind's supplier record on chain names proof ${record.proofHash}`,
  );
}
process.exit(failed ? 1 : 0);
