import { keccak256, toHex } from 'viem';

/**
 * A scripted gateway for the MCP and A2A tests: one order; a payment to the address on file
 * settles, any other is held.
 */
export const ACCOUNT = '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603';
export const VAULT = '0x771d1b283D9Bf9A6e14bAdF0c9C4d1BE05D87dC7';
export const ON_FILE = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
/** What the owner decided on a proposal, for the in-chat question's retry (Slice 14). */
export const proposalStatus = { value: 'pending' };

/** The owner decides on a held payment on the approval page (Slice 14's tests). */
export function decide(id: string, status: 'refused' | 'settled'): void {
  const v = requests.get(id);
  if (!v) throw new Error(`no request ${id}`);
  v.status = status;
  v.reason = status === 'refused' ? 'user_refused' : null;
  v.decidedBy = status === 'refused' ? 'user_refused' : 'user_once';
}

export const LOOK_ALIKE = '0x90f9931B748B26763161a8191C178Fe425C25fEd';
export const ORDER_ID = keccak256(toHex('order 1'));
export const MCP_TOKEN = 'mcp-test-token-0123456789abcdef';
export const TX = `0x${'ab'.repeat(32)}`;

export const sent: { path: string; body: unknown }[] = [];
const requests = new Map<string, Record<string, unknown>>();
const byInvoice = new Map<string, Record<string, unknown>>();
export function gateway(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  sent.push({ path: url.pathname, body });
  const reply = (status: number, json: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const view = (id: string, payTo: string, held: boolean) => ({
    id,
    runId: null,
    status: held ? 'held' : 'settled',
    reason: held ? 'address_mismatch' : null,
    decidedBy: held ? 'rule' : 'checker',
    account: ACCOUNT,
    vault: VAULT,
    payTo,
    amount: '12500000',
    invoiceHash: '0x',
    deadline: 1,
    evidence: held
      ? { contract: 'PayToNotOnFile', payTo: { onFile: ON_FILE, invoice: payTo } }
      : null,
    tx: {
      hash: held ? null : TX,
      relayer: null,
      nonce: null,
      block: null,
      proposedAt: null,
      votedAt: null,
      finalizedAt: null,
    },
    timings: { checkMs: 300, personMs: null, settleMs: held ? null : 900 },
    statusUrl: `https://gateway.test/p/${id}`,
  });
  if (url.pathname.endsWith('/orders'))
    return reply(200, {
      account: ACCOUNT,
      indexedTo: 1,
      orders: [
        {
          orderId: ORDER_ID,
          vault: VAULT,
          supplierId: keccak256(toHex('kalibre-studio')),
          payTo: ON_FILE,
          supplierActive: true,
          activeAfter: 0,
          amount: '30000000',
          remaining: '17500000',
          expiry: 1_800_000_000,
          approvedBlock: 1,
        },
      ],
    });
  if (url.pathname === '/v1/payments' && init?.method === 'POST') {
    const payTo = (body?.payment as { payTo: string }).payTo;
    const invoice = (body?.payment as { invoiceHash: string }).invoiceHash;
    const earlier = byInvoice.get(invoice);
    if (earlier) return reply(200, { created: false, request: earlier });
    const id = `0x${String(requests.size + 1).padStart(64, '0')}`;
    const v = view(id, payTo, payTo.toLowerCase() !== ON_FILE.toLowerCase());
    requests.set(id, v);
    byInvoice.set(invoice, v);
    return reply(201, { created: true, request: v });
  }
  if (url.pathname === '/v1/advice') {
    // Slice 17: Kalibre's account on file is GB29…; anything else on the invoice is a mismatch.
    const doc = JSON.stringify(body?.document ?? '');
    const changed = doc.includes('GB33');
    return reply(200, {
      id: '0xadvice',
      advice: changed ? 'mismatch' : 'match',
      reason: changed ? 'bank_account_mismatch' : null,
      reasonText: changed
        ? "The invoice's bank account is not the supplier's account on file."
        : null,
      said: changed
        ? "Advice: do not pay this invoice. The invoice's bank account is not the supplier's account on file. Advice only: do not pay it until the supplier confirms the account by phone, on a number you already have."
        : 'Advice: the bank account on this invoice is the supplier’s account on file, and nothing else on it differs from the order. Countersign cannot stop or confirm a bank transfer: it is paid at the bank.',
      invoiceNumber: 'KS-1007',
      onFile: {
        source: 'demo',
        holder: 'Kalibre Studio Ltd',
        iban: 'GB29NWBK60161331926819',
        description: 'Kalibre Studio Ltd, IBAN GB29 NWBK 6016 1331 9268 19',
      },
      evidence: {},
      checkedAt: '2026-10-08T00:00:00.000Z',
    });
  }
  if (url.pathname === '/v1/checks') {
    const payTo = (body?.payment as { payTo: string }).payTo;
    return payTo.toLowerCase() === ON_FILE.toLowerCase()
      ? reply(200, { verdict: 'would_settle', reason: null, decidedBy: 'checker', evidence: {} })
      : reply(200, {
          verdict: 'held',
          reason: 'address_mismatch',
          decidedBy: 'rule',
          evidence: { payTo: { onFile: ON_FILE, invoice: payTo } },
        });
  }
  if (url.pathname === '/v1/runs' && init?.method === 'POST')
    return reply(201, { runId: '0xrun', requests: [{ id: '0x1', status: 'requested' }] });
  if (url.pathname === '/v1/runs/0xrun')
    return reply(200, { runId: '0xrun', size: 2, byStatus: { settled: 1, held: 1 }, requests: [] });
  if (url.pathname.startsWith('/v1/payments/')) {
    const v = requests.get(url.pathname.split('/')[3] ?? '');
    return v ? reply(200, v) : reply(404, { error: 'unknown_request' });
  }
  if (url.pathname.startsWith('/v1/runs/')) return reply(404, { error: 'unknown_run' });
  if (url.pathname === '/v1/proposals')
    return reply(201, {
      created: true,
      proposal: {
        id: '0xprop',
        status: 'pending',
        approvalUrl: 'https://gateway.test/p/0xprop',
        supplierName: 'Kalibre Studio',
      },
    });
  if (url.pathname === '/v1/proposals/0xprop')
    return reply(200, {
      id: '0xprop',
      status: proposalStatus.value,
      approvalUrl: 'https://gateway.test/p/0xprop',
      supplierName: 'Kalibre Studio',
    });
  return reply(404, { error: 'unknown_proposal' });
}
