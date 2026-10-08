import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keccak256, recoverTypedDataAddress, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { invoiceHash, paymentTypes, vaultDomain } from '@countersign/shared';
import { Countersign, CountersignError, paymentDigest, type Order } from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../shared/test/fixtures/eip712.json', import.meta.url), 'utf8'),
) as { Payment: Hex; chainId: number; vault: Hex };

const ACCOUNT = '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603';
const VAULT = '0x771d1b283D9Bf9A6e14bAdF0c9C4d1BE05D87dC7';
const SUPPLIER_ID = keccak256(toHex('kalibre-studio'));
const PAY_TO = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
const agentKey = generatePrivateKey();

type Call = { url: string; method: string; body: unknown; auth: string | null };

/** A gateway that answers from a script and records what it was sent. */
function fakeGateway(answer: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Call = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const { status, body } = answer(call);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch: fetchFn };
}

const order: Order = {
  orderId: keccak256(toHex('order 1')),
  vault: VAULT,
  supplierId: SUPPLIER_ID,
  payTo: PAY_TO,
  supplierActive: true,
  activeAfter: 0,
  amount: '30000',
  remaining: '13600',
  expiry: 1_800_000_000,
  approvedBlock: 1,
};
const view = (status: string, extra: Record<string, unknown> = {}) => ({
  id: '0xrequest',
  runId: null,
  status,
  reason: null,
  decidedBy: null,
  account: ACCOUNT,
  vault: VAULT,
  payTo: PAY_TO,
  amount: '12500000',
  invoiceHash: '0x',
  deadline: 1,
  evidence: null,
  tx: {
    hash: null,
    relayer: null,
    nonce: null,
    block: null,
    proposedAt: null,
    votedAt: null,
    finalizedAt: null,
  },
  timings: { checkMs: null, personMs: null, settleMs: null },
  statusUrl: 'https://gateway.example/p/0xrequest',
  ...extra,
});

function client(gateway: ReturnType<typeof fakeGateway>) {
  return new Countersign({
    gateway: 'https://gateway.example/',
    token: 'service-token',
    account: ACCOUNT,
    agentKey,
    fetch: gateway.fetch,
  });
}

describe('signing', () => {
  it('produces the digest the vault computes (Slice 5 fixture)', () => {
    const digest = paymentDigest(fixture.chainId, fixture.vault, {
      amount: 10_000n,
      invoiceHash: keccak256(toHex('invoice INV-0042, PDF')),
      payTo: '0x3000000000000000000000000000000000000003',
      deadline: 1_790_003_600n,
    });
    expect(digest).toBe(fixture.Payment);
  });
});

describe('pay', () => {
  it('signs the payment with the agent key and sends the invoice the way the gateway reads it', async () => {
    const gateway = fakeGateway((call) =>
      call.url.endsWith('/orders')
        ? { status: 200, body: { account: ACCOUNT, indexedTo: 1, orders: [order] } }
        : { status: 201, body: { created: true, request: view('requested') } },
    );
    const result = await client(gateway).pay({
      order: order.orderId,
      invoice: { number: ' inv-0042 ', amount: '12.50', payTo: PAY_TO },
    });
    expect(result.status).toBe('requested');
    const sent = gateway.calls.find((c) => c.url.endsWith('/v1/payments'));
    expect(sent?.auth).toBe('Bearer service-token');
    const body = sent?.body as {
      account: string;
      vault: Hex;
      agentSig: Hex;
      payment: { amount: string; invoiceHash: Hex; payTo: Hex; deadline: number };
    };
    expect(body).toMatchObject({ account: ACCOUNT, vault: VAULT });
    expect(body.payment.amount).toBe('12500000');
    expect(body.payment.invoiceHash).toBe(invoiceHash(SUPPLIER_ID, 'INV-0042'));
    const signer = await recoverTypedDataAddress({
      domain: vaultDomain(10143, VAULT),
      types: paymentTypes,
      primaryType: 'Payment',
      message: {
        ...body.payment,
        amount: BigInt(body.payment.amount),
        deadline: BigInt(body.payment.deadline),
      },
      signature: body.agentSig,
    });
    expect(signer).toBe(privateKeyToAccount(agentKey).address);
  });

  it('says when a payment is the same invoice sent again (nothing new paid)', async () => {
    const gateway = fakeGateway((call) =>
      call.method === 'POST'
        ? { status: 200, body: { created: false, request: view('settled') } }
        : { status: 200, body: view('settled') },
    );
    const result = await client(gateway).pay({
      order,
      invoice: { number: 'INV-0042', amount: '12.50', payTo: PAY_TO },
    });
    expect(result.duplicate).toBe(true);
  });

  it('waits for the outcome when asked: settled, held or blocked', async () => {
    let polls = 0;
    const gateway = fakeGateway((call) => {
      if (call.method === 'POST')
        return { status: 201, body: { created: true, request: view('requested') } };
      polls++;
      return {
        status: 200,
        body: view(polls < 3 ? 'settling' : 'held', { reason: 'address_mismatch' }),
      };
    });
    const result = await client(gateway).pay({
      order,
      invoice: { number: 'INV-0045', amount: 1_000n, payTo: PAY_TO },
      wait: { pollMs: 1 },
    });
    expect(result.status).toBe('held');
    expect(result.reason).toBe('address_mismatch');
    expect(result.reasonText).toBe(
      "The invoice's payment address is not the supplier's address on file.",
    );
  });

  it('refuses an order it cannot find, and an amount that is not a USDC amount', async () => {
    const gateway = fakeGateway(() => ({
      status: 200,
      body: { account: ACCOUNT, indexedTo: 1, orders: [] },
    }));
    await expect(
      client(gateway).pay({
        order: order.orderId,
        invoice: { number: 'X', amount: '1', payTo: PAY_TO },
      }),
    ).rejects.toMatchObject({ code: 'unknown_order' });
    await expect(
      client(gateway).pay({ order, invoice: { number: 'X', amount: '1.5e3', payTo: PAY_TO } }),
    ).rejects.toThrow(/USDC amount/);
  });

  it('needs an agent key to pay', async () => {
    const gateway = fakeGateway(() => ({ status: 201, body: {} }));
    const noKey = new Countersign({
      gateway: 'https://g.example',
      token: 't',
      account: ACCOUNT,
      fetch: gateway.fetch,
    });
    await expect(
      noKey.pay({ order, invoice: { number: 'X', amount: '1', payTo: PAY_TO } }),
    ).rejects.toMatchObject({
      code: 'no_agent_key',
    });
  });
});

describe('errors', () => {
  it('turns the gateway’s typed errors into CountersignError, with the field issues', async () => {
    const gateway = fakeGateway(() => ({
      status: 400,
      body: { error: 'malformed', issues: [{ path: 'payment.payTo', message: 'Invalid' }] },
    }));
    const error = await client(gateway)
      .status('0xnothing')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CountersignError);
    expect(error).toMatchObject({
      code: 'malformed',
      status: 400,
      issues: [{ path: 'payment.payTo' }],
    });
  });

  it('reports a network failure as such', async () => {
    const down = new Countersign({
      gateway: 'https://g.example',
      token: 't',
      account: ACCOUNT,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(down.orders()).rejects.toMatchObject({ code: 'network' });
  });
});
