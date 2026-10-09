'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { call, GatewayError } from '../../../lib/gateway';
import { passkeyProblem, signChallenge, type Assertion } from '../../../lib/passkey';
import { loadSession } from '../../../lib/session';
import { Address, explorer, Problem, Signed } from '../../ui';

/**
 * The approval sheet (Slice 11, FEATURES 1 and 2): a held payment (pay once or refuse) or a proposed
 * supplier and order (approve or refuse), each decided with the owner's passkey. What is signed is
 * the challenge the gateway gives, checked by the account's contract itself.
 */

type Action = {
  challenge: string;
  summary?: string;
  signatures?: { need: number; signed: number[] };
};
type WebsiteProof = { status: string; site: string | null; text: string; txHash?: string | null };
type View = {
  id: string;
  kind: 'payment' | 'proposal';
  status: string;
  title: string;
  summary: Record<string, unknown> & {
    amountUsdc?: string;
    payTo?: string;
    addressOnFile?: string | null;
    reason?: string | null;
    reasonText?: string | null;
    payOnce?: string | null;
    txHash?: string | null;
    supplierName?: string;
    website?: string | null;
    websiteProof?: WebsiteProof | null;
    changesAddress?: boolean;
    enoughFunds?: boolean;
    accountUsdc?: string;
    expiry?: string;
  };
  differences: { field: string; onFile: string; onInvoice: string }[];
  actions: Record<string, Action>;
};
type Finding = { check: string; ok: boolean; detail: string };

export default function Approve() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView((await call<View>(`/v1/approvals/${id}`)).body);
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : String(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  // What the checker found (the "why"): needs this phone's token for the account.
  useEffect(() => {
    const s = loadSession();
    if (!s.token || view?.kind !== 'payment') return;
    call<{ evidence?: { findings?: Finding[] } }>(`/v1/payments/${id}`, { token: s.token })
      .then((r) => {
        setFindings(r.body.evidence?.findings ?? null);
      })
      .catch(() => {
        setFindings(null);
      });
  }, [id, view?.kind]);

  async function decide(action: 'pay_once' | 'refuse' | 'approve') {
    if (!view) return;
    setProblem(null);
    const { credentialId } = loadSession();
    try {
      let body: Record<string, unknown>;
      if (action === 'approve') {
        // One Face ID per step: the supplier (when new or changed), then the order.
        const steps = ['set_supplier', 'approve_order'].filter((k) => view.actions[k]);
        const assertions: Record<string, Assertion> = {};
        for (const [i, k] of steps.entries()) {
          const step = view.actions[k];
          if (!step) continue;
          setBusy(
            `Face ID ${String(i + 1)} of ${String(steps.length)}: ${step.summary ?? k.replace('_', ' ')}`,
          );
          assertions[k] = await signChallenge(step.challenge, credentialId);
        }
        body = { action, assertions };
      } else {
        const a = view.actions[action];
        if (!a) return;
        setBusy(action === 'refuse' ? 'Face ID to refuse…' : 'Face ID to pay once…');
        body = { action, assertion: await signChallenge(a.challenge, credentialId) };
      }
      setBusy('Checking with the account on Monad…');
      const r = await call<View>(`/v1/approvals/${id}`, { method: 'POST', body });
      setView(r.body);
      setDone(
        r.status === 202
          ? 'Your signature is counted. Another owner needs to sign too.'
          : action === 'refuse'
            ? 'Refused. Nothing was paid, and your agent has been told.'
            : action === 'approve'
              ? 'Approved. Your agent can now pay this supplier within the order.'
              : 'Paid once. It settles on Monad in about a second.',
      );
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : passkeyProblem(e));
      void load();
    } finally {
      setBusy(null);
    }
  }

  if (!view) return <Problem text={problem} />;
  const s = view.summary;
  const open = Object.keys(view.actions).length > 0;
  const failed = findings?.filter((f) => !f.ok) ?? [];

  return (
    <>
      <p className="small muted">
        {view.kind === 'proposal' ? 'Proposed by your agent' : 'Payment'}
      </p>
      <h1>
        {view.kind === 'proposal'
          ? `Add ${s.supplierName ?? 'a supplier'}?`
          : view.status === 'held'
            ? 'Held for you'
            : view.title}
      </h1>
      <p className="amount">{s.amountUsdc} USDC</p>

      {view.kind === 'payment' && s.reasonText && (
        <p className="note warn">
          <strong>Why it is held: </strong>
          {s.reasonText}
        </p>
      )}

      {view.differences.length > 0 && (
        <section className="card">
          <h2>
            {view.kind === 'proposal'
              ? 'The address changes'
              : 'The address is not the one on file'}
          </h2>
          {view.differences.map((d) => (
            <div key={d.field} className="list">
              <div>
                <p className="small muted">On file (the only address this account pays)</p>
                <Address value={d.onFile} against={d.onInvoice} />
              </div>
              <div>
                <p className="small muted">
                  {view.kind === 'proposal' ? 'Proposed' : 'On the invoice'}
                </p>
                <Address value={d.onInvoice} against={d.onFile} />
              </div>
            </div>
          ))}
          <p className="small muted">The highlighted characters differ.</p>
        </section>
      )}

      {view.kind === 'proposal' && (
        <section className="card">
          <h2>{s.supplierName}</h2>
          <dl className="kv">
            <dt>Pays</dt>
            <dd>
              <Address value={s.payTo ?? ''} />
            </dd>
            {s.website && (
              <>
                <dt>Website</dt>
                <dd>{s.website}</dd>
              </>
            )}
            <dt>Order</dt>
            <dd>
              {s.amountUsdc} USDC, until {s.expiry ? new Date(s.expiry).toLocaleDateString() : '?'}
            </dd>
            <dt>Your account has</dt>
            <dd>{s.accountUsdc} USDC</dd>
          </dl>
          {s.websiteProof && (
            <p
              className={`note ${s.websiteProof.status === 'verified' ? 'ok' : s.websiteProof.status === 'checking' ? 'warn' : 'bad'}`}
            >
              {s.websiteProof.text}
              {s.websiteProof.txHash && (
                <>
                  {' '}
                  <a href={explorer(s.websiteProof.txHash)} target="_blank" rel="noreferrer">
                    The proof on Monad
                  </a>
                </>
              )}
            </p>
          )}
          {s.enoughFunds === false && (
            <p className="note bad">Your account does not hold enough USDC for this order.</p>
          )}
        </section>
      )}

      {view.kind === 'payment' && failed.length > 0 && (
        <section className="card">
          <h2>What the checker found</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {failed.map((f, i) => (
              <li key={i}>{f.detail}</li>
            ))}
          </ul>
        </section>
      )}

      {busy && (
        <p className="note ok" aria-live="polite">
          {busy}
        </p>
      )}
      {done && <p className="note ok">{done}</p>}
      <Problem text={problem} />

      {open && (
        <section className="card">
          {view.kind === 'payment' && s.payOnce === 'address_not_on_file' && (
            <p className="small muted">
              There is no “pay anyway”: this account pays only the supplier’s address on file. If
              the supplier really changed its address, your agent proposes the change for you to
              approve.
            </p>
          )}
          <div className={`choices${Object.keys(view.actions).length === 1 ? ' one' : ''}`}>
            {view.actions.pay_once && (
              <button className="primary" onClick={() => void decide('pay_once')} disabled={!!busy}>
                Pay once <Signed signatures={view.actions.pay_once.signatures} />
              </button>
            )}
            {(view.actions.approve_order ?? view.actions.set_supplier) && (
              <button className="primary" onClick={() => void decide('approve')} disabled={!!busy}>
                Approve <Signed signatures={view.actions.approve_order?.signatures} />
              </button>
            )}
            {view.actions.refuse && (
              <button className="danger" onClick={() => void decide('refuse')} disabled={!!busy}>
                Refuse
              </button>
            )}
          </div>
          <p className="small muted">
            {view.kind === 'payment'
              ? 'Refusing stops your agent’s run and is written on Monad.'
              : 'Nothing is added and no money moves until you approve.'}
          </p>
        </section>
      )}

      {!open && view.status !== 'held' && view.status !== 'pending' && (
        <section className="card">
          <p>
            {view.status === 'settled'
              ? 'Paid.'
              : view.status === 'refused'
                ? 'Refused: nothing was paid.'
                : `Status: ${view.status}.`}
          </p>
          {s.txHash && (
            <a href={explorer(s.txHash)} target="_blank" rel="noreferrer">
              The payment on Monad
            </a>
          )}
          {view.kind === 'payment' && <a href={`/record/${view.id}`}>The full record</a>}
        </section>
      )}
    </>
  );
}
