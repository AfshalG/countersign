'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { call, GatewayError } from '../../../lib/gateway';
import { loadSession } from '../../../lib/session';
import { Address, Problem } from '../../ui';

/**
 * A payment's record (Slice 11, FEATURES 3; Slice 18): what was asked, what was checked, who
 * decided and where each decision is on Monad, as one file an auditor can verify with
 * `npx countersign-verify`. Needs this phone's account token.
 */

type OnChain = {
  by: 'checker' | 'owner';
  tx: { hash: string; url: string; final: boolean; status: string | null } | null;
};
type RecordFile = {
  payment: {
    id: string;
    amountUsdc: string;
    payTo: string;
    invoiceHash: string;
    order: { supplierName: string | null } | null;
    agent: { address: string; agentId: string | null } | null;
  };
  check: {
    status: string;
    reasonText: string | null;
    decidedBy: string | null;
    evidenceHash: string | null;
    evidence: { findings?: { check: string; ok: boolean; detail: string }[] } | null;
  };
  decision: {
    by: string | null;
    at: string | null;
    onChain: OnChain[];
    onChainNote: string | null;
  };
  settlement: { tx: { hash: string; url: string; finalizedAt: string | null } } | null;
  events: { to: string; at: string; reason: string | null }[];
};

const who: Record<string, string> = {
  checker: 'the checker',
  rule: 'the account’s own rules',
  user_once: 'the owner, with Face ID',
  user_refused: 'the owner, with Face ID',
};

export default function Record() {
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<RecordFile | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const s = loadSession();
    if (!s.token) {
      setProblem('Connect this phone to the account first (on the home screen) to read records.');
      return;
    }
    call<RecordFile>(`/v1/payments/${id}/record`, { token: s.token })
      .then((r) => {
        setRecord(r.body);
        setRaw(JSON.stringify(r.body, null, 2));
      })
      .catch((e: unknown) => {
        setProblem(e instanceof GatewayError ? e.message : String(e));
      });
  }, [id]);

  function download() {
    if (!raw) return;
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `countersign-record-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!record) return <Problem text={problem} />;
  const p = record.payment;
  const failed = record.check.evidence?.findings?.filter((f) => !f.ok) ?? [];
  return (
    <>
      <p className="small muted">The record</p>
      <h1>
        {p.amountUsdc} USDC{p.order?.supplierName ? ` for ${p.order.supplierName}` : ''}
      </h1>
      <section className="card">
        <dl className="kv">
          <dt>Outcome</dt>
          <dd>{record.check.status}</dd>
          {record.check.reasonText && (
            <>
              <dt>Why</dt>
              <dd>{record.check.reasonText}</dd>
            </>
          )}
          <dt>Decided by</dt>
          <dd>{who[record.decision.by ?? ''] ?? record.decision.by ?? '–'}</dd>
          <dt>To</dt>
          <dd>
            <Address value={p.payTo} />
          </dd>
          {p.agent && (
            <>
              <dt>Agent</dt>
              <dd>{p.agent.agentId ? `#${p.agent.agentId} (ERC-8004)` : p.agent.address}</dd>
            </>
          )}
        </dl>
      </section>
      {failed.length > 0 && (
        <section className="card">
          <h2>What the checker found</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {failed.map((f, i) => (
              <li key={i}>{f.detail}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        <h2>On Monad</h2>
        {record.decision.onChain.map((d) => (
          <p key={d.by} className="small">
            {d.by === 'owner' ? 'The refusal' : 'The checker’s hold'}, with the hash of its
            evidence:{' '}
            {d.tx ? (
              <a href={d.tx.url} target="_blank" rel="noreferrer">
                {d.tx.final ? 'final' : 'on its way'}
              </a>
            ) : (
              'not sent yet'
            )}
          </p>
        ))}
        {record.settlement && (
          <p className="small">
            The payment:{' '}
            <a href={record.settlement.tx.url} target="_blank" rel="noreferrer">
              final on Monad
            </a>
          </p>
        )}
        {record.decision.onChainNote && (
          <p className="small muted">{record.decision.onChainNote}</p>
        )}
        {record.check.evidenceHash && (
          <p className="small muted addr">Evidence hash {record.check.evidenceHash}</p>
        )}
      </section>
      <section className="card">
        <h2>What happened</h2>
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {record.events.map((e, i) => (
            <li key={i}>
              {e.to}
              {e.reason ? ` (${e.reason})` : ''}, {new Date(e.at).toLocaleTimeString()}
            </li>
          ))}
        </ol>
      </section>
      <button className="primary" onClick={download}>
        Download the record
      </button>
      <p className="small muted">
        Anyone can check it against Monad: <code>npx countersign-verify</code> on the file.
      </p>
    </>
  );
}
