import { decodeEventLog, getAddress, parseAbi, type Hex } from 'viem';
import { evidenceHash } from '@countersign/shared';

/**
 * Verifying a payment record against Monad (Slice 18), without trusting Countersign: the evidence
 * and document hashes are recomputed from the record, and the decision's and the settlement's
 * transactions are read from Monad's own RPC and compared with it. Each check passes or fails on
 * its own, with what it saw.
 */

/** The vault's two events, as in contracts/src/OrderVault.sol (a test keeps them the same). */
export const VAULT_EVENTS = parseAbi([
  'event PaymentExecuted(bytes32 indexed invoiceHash, address indexed payTo, uint256 amount, uint256 remaining, uint8 decidedBy)',
  'event DecisionRecorded(bytes32 indexed invoiceHash, uint8 outcome, bytes32 reasonHash, bytes32 evidenceHash, uint8 decidedBy)',
]);

/** Monad testnet's own public RPC. */
export const MONAD_TESTNET_RPC = 'https://testnet-rpc.monad.xyz';

/** The parts of a `countersign-record/1` file that are verified. */
export type PaymentRecord = {
  format: 'countersign-record/1';
  chain: { id: number };
  payment: { id: string; vault: string; invoiceHash: string; payTo: string; amount: string };
  document: { content: unknown; hash: string | null };
  check: { evidence: unknown; evidenceHash: string | null };
  decision: {
    /** The checker's hold, then the owner's refusal: each written on Monad on its own. */
    onChain: {
      by: 'checker' | 'owner';
      decision: { invoiceHash: string; outcome: number; reasonHash: string; evidenceHash: string };
      tx: { hash: string } | null;
    }[];
  };
  settlement: { tx: { hash: string } } | null;
};

export type Verification = {
  ok: boolean;
  checks: { check: string; ok: boolean; detail: string }[];
};

type Receipt = {
  status: Hex;
  logs: { address: string; topics: Hex[]; data: Hex }[];
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function verifyRecord(
  record: PaymentRecord,
  options: { rpcUrl?: string; fetch?: typeof fetch } = {},
): Promise<Verification> {
  if ((record as { format?: unknown }).format !== 'countersign-record/1')
    throw new Error('not a payment record: its format is not countersign-record/1');
  const url = options.rpcUrl ?? MONAD_TESTNET_RPC;
  const f = options.fetch ?? fetch;
  let id = 0;
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };
  const checks: Verification['checks'] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  const chainId = Number(await call<Hex>('eth_chainId', []));
  add(
    'chain',
    chainId === record.chain.id,
    chainId === record.chain.id
      ? `the RPC is chain ${String(chainId)}, the record's`
      : `the RPC is chain ${String(chainId)}; the record is of chain ${String(record.chain.id)}`,
  );

  if (record.check.evidenceHash !== null) {
    const h = evidenceHash(record.check.evidence);
    add(
      'evidence hash',
      same(h, record.check.evidenceHash),
      same(h, record.check.evidenceHash)
        ? `the evidence hashes to ${h}`
        : `the evidence hashes to ${h}, not the record's ${record.check.evidenceHash}: it was changed`,
    );
  }
  if (record.document.hash !== null) {
    const h = evidenceHash(record.document.content);
    add(
      'document hash',
      same(h, record.document.hash),
      same(h, record.document.hash)
        ? `the document hashes to ${h}`
        : `the document hashes to ${h}, not the record's ${record.document.hash}: it was changed`,
    );
  }

  /** The vault's event of this name in a transaction's receipt, decoded. */
  const eventIn = async (hash: string, eventName: 'PaymentExecuted' | 'DecisionRecorded') => {
    const receipt = await call<Receipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt === null) return { error: `Monad has no transaction ${hash}` };
    if (receipt.status !== '0x1') return { error: `transaction ${hash} reverted` };
    for (const log of receipt.logs) {
      if (!same(log.address, record.payment.vault)) continue;
      try {
        const ev = decodeEventLog({
          abi: VAULT_EVENTS,
          topics: log.topics as [Hex],
          data: log.data,
        });
        if (ev.eventName === eventName) return { args: ev.args as Record<string, unknown> };
      } catch {
        // another of the vault's events
      }
    }
    return {
      error: `transaction ${hash} has no ${eventName} from the vault ${record.payment.vault}`,
    };
  };

  for (const onChain of record.decision.onChain) {
    const d = onChain.decision;
    const whose = onChain.by === 'checker' ? 'the checker’s hold' : 'the owner’s refusal';
    const ok =
      same(d.invoiceHash, record.payment.invoiceHash) &&
      record.check.evidenceHash !== null &&
      same(d.evidenceHash, record.check.evidenceHash);
    add(
      `${whose} names this payment and its evidence`,
      ok,
      ok
        ? 'its invoice hash is the payment’s and its evidence hash is the evidence’s'
        : 'it names another invoice or other evidence than this record’s',
    );
    if (onChain.tx) {
      const found = await eventIn(onChain.tx.hash, 'DecisionRecorded');
      if ('error' in found) add(`${whose} on Monad`, false, found.error ?? '');
      else {
        const a = found.args;
        const by = onChain.by === 'checker' ? 0 : 1;
        const match =
          same(String(a.invoiceHash), d.invoiceHash) &&
          Number(a.outcome) === d.outcome &&
          same(String(a.reasonHash), d.reasonHash) &&
          same(String(a.evidenceHash), d.evidenceHash) &&
          Number(a.decidedBy) === by;
        add(
          `${whose} on Monad`,
          match,
          match
            ? `DecisionRecorded in ${onChain.tx.hash}, as recorded`
            : `DecisionRecorded in ${onChain.tx.hash} differs from the record: ${JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`,
        );
      }
    }
  }

  if (record.settlement) {
    const found = await eventIn(record.settlement.tx.hash, 'PaymentExecuted');
    if ('error' in found) add('settlement on Monad', false, found.error ?? '');
    else {
      const a = found.args;
      const match =
        same(String(a.invoiceHash), record.payment.invoiceHash) &&
        getAddress(String(a.payTo)) === getAddress(record.payment.payTo) &&
        BigInt(String(a.amount)) === BigInt(record.payment.amount);
      add(
        'settlement on Monad',
        match,
        match
          ? `PaymentExecuted in ${record.settlement.tx.hash}: ${record.payment.amount} to ${record.payment.payTo}`
          : `PaymentExecuted in ${record.settlement.tx.hash} pays ${String(a.amount)} to ${String(a.payTo)}, not the record's`,
      );
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
