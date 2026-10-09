import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
  toEventSelector,
  type Hex,
} from 'viem';
import { orderVaultAbi } from '@countersign/chain';
import { evidenceHash, OUTCOME, reasonHash } from '@countersign/shared';
import { VAULT_EVENTS, verifyRecord, type PaymentRecord } from '../src/verify.js';

/**
 * Slice 18: anyone can check a payment record against Monad without trusting Countersign: the
 * hashes are recomputed, and the decision's and the settlement's transactions are read from the
 * chain and compared with the record.
 */
const VAULT = '0x771d1b283D9Bf9A6e14bAdF0c9C4d1BE05D87dC7';
const PAY_TO = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
const INVOICE = keccak256(stringToHex('KS-1003'));
const evidence = { checker: 'countersign-checker/1', findings: [{ check: 'amount', ok: false }] };
const document = { text: 'Invoice KS-1003' };
const DECISION_TX = keccak256(stringToHex('decision tx'));
const SETTLE_TX = keccak256(stringToHex('settle tx'));

const held = (): PaymentRecord => ({
  format: 'countersign-record/1',
  chain: { id: 10143 },
  payment: { id: '0x01', vault: VAULT, invoiceHash: INVOICE, payTo: PAY_TO, amount: '1000' },
  document: { content: document, hash: evidenceHash(document) },
  check: { evidence, evidenceHash: evidenceHash(evidence) },
  decision: {
    onChain: {
      by: 'checker',
      decision: {
        invoiceHash: INVOICE,
        outcome: OUTCOME.held,
        reasonHash: reasonHash('amount_mismatch'),
        evidenceHash: evidenceHash(evidence),
      },
      tx: { hash: DECISION_TX },
    },
  },
  settlement: null,
});

const decisionLog = (evidenceH: Hex = evidenceHash(evidence), from = VAULT) => ({
  address: from,
  topics: encodeEventTopics({
    abi: orderVaultAbi,
    eventName: 'DecisionRecorded',
    args: { invoiceHash: INVOICE },
  }),
  data: encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
    // decidedBy: the vault's DecidedBy enum, Checker = 0, Owner = 1.
    [OUTCOME.held, reasonHash('amount_mismatch'), evidenceH, 0],
  ),
});
const paidLog = (amount = 1000n) => ({
  address: VAULT,
  topics: encodeEventTopics({
    abi: orderVaultAbi,
    eventName: 'PaymentExecuted',
    args: { invoiceHash: INVOICE, payTo: PAY_TO },
  }),
  data: encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }],
    [amount, 4000n, 1],
  ),
});

/** A Monad RPC that answers the chain id and the receipts it is given. */
const rpc = (receipts: Record<string, { status: Hex; logs: unknown[] } | null>) =>
  ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const result =
      body.method === 'eth_chainId' ? '0x279f' : (receipts[String(body.params[0])] ?? null);
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })));
  }) as typeof fetch;

const failed = (r: Awaited<ReturnType<typeof verifyRecord>>) =>
  r.checks.filter((c) => !c.ok).map((c) => c.check);

describe('verifying a payment record against Monad', () => {
  it('uses exactly the vault’s event signatures', () => {
    for (const name of ['PaymentExecuted', 'DecisionRecorded'] as const)
      expect(toEventSelector(VAULT_EVENTS.find((e) => e.name === name) as never)).toBe(
        toEventSelector(orderVaultAbi.find((e) => e.type === 'event' && e.name === name) as never),
      );
  });

  it('passes a held payment whose decision is on Monad as recorded', async () => {
    const r = await verifyRecord(held(), {
      fetch: rpc({ [DECISION_TX]: { status: '0x1', logs: [decisionLog()] } }),
    });
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.check)).toEqual([
      'chain',
      'evidence hash',
      'document hash',
      'decision names this payment and its evidence',
      'decision on Monad',
    ]);
  });

  it('fails evidence changed after the fact, and a decision on chain over other evidence', async () => {
    const tampered = held();
    tampered.check.evidence = { ...evidence, findings: [] };
    const r = await verifyRecord(tampered, {
      fetch: rpc({ [DECISION_TX]: { status: '0x1', logs: [decisionLog()] } }),
    });
    expect(failed(r)).toEqual(['evidence hash']);

    const other = await verifyRecord(held(), {
      fetch: rpc({
        [DECISION_TX]: { status: '0x1', logs: [decisionLog(evidenceHash({ other: 1 }))] },
      }),
    });
    expect(failed(other)).toEqual(['decision on Monad']);
    expect(other.ok).toBe(false);
  });

  it('fails a decision emitted by another contract, or a transaction Monad does not have', async () => {
    const wrongVault = await verifyRecord(held(), {
      fetch: rpc({
        [DECISION_TX]: {
          status: '0x1',
          logs: [decisionLog(undefined, '0x1111111111111111111111111111111111111111')],
        },
      }),
    });
    expect(failed(wrongVault)).toEqual(['decision on Monad']);
    const missing = await verifyRecord(held(), { fetch: rpc({}) });
    expect(failed(missing)).toEqual(['decision on Monad']);
  });

  it('checks a settlement’s PaymentExecuted: the invoice, the address and the amount', async () => {
    const paid: PaymentRecord = {
      ...held(),
      decision: { onChain: null },
      settlement: { tx: { hash: SETTLE_TX } },
    };
    const ok = await verifyRecord(paid, {
      fetch: rpc({ [SETTLE_TX]: { status: '0x1', logs: [paidLog()] } }),
    });
    expect(failed(ok)).toEqual([]);
    const more = await verifyRecord(paid, {
      fetch: rpc({ [SETTLE_TX]: { status: '0x1', logs: [paidLog(2000n)] } }),
    });
    expect(failed(more)).toEqual(['settlement on Monad']);
  });

  it('refuses a file that is not a record, and a record of another chain', async () => {
    await expect(verifyRecord({ format: 'other' } as never, { fetch: rpc({}) })).rejects.toThrow(
      /countersign-record\/1/,
    );
    const elsewhere = await verifyRecord({ ...held(), chain: { id: 1 } }, { fetch: rpc({}) });
    expect(failed(elsewhere)).toContain('chain');
  });
});
