'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { call, GatewayError } from '../../../lib/gateway';
import { passkeyProblem, signChallenge, type Assertion } from '../../../lib/passkey';
import { loadSession } from '../../../lib/session';
import { mustMatch, whatIsPaid } from '../../../lib/verify';
import { formatUsdc } from '@countersign/shared';
import { AddressCompare, Busy, Decided, HoldButton, Skeleton, Track, type Step } from '../../fx';
import { Icon } from '../../icons';
import { Address, explorer, Note, Problem, Proof, Signed, Waiting } from '../../ui';

/**
 * The approval sheet (Slice 11, FEATURES 1 and 2): a held payment (pay once or refuse) or a proposed
 * supplier and order (approve or refuse), each decided with the owner's passkey. What is signed is
 * the challenge the gateway gives, checked by the account's contract itself.
 */

type Action = {
  challenge: string;
  typedData?: unknown;
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

  // Keep the screen true while something is moving: a payment settling after Pay once (about a
  // second), or the supplier's website being proven (a few seconds). Polls stop at a final state.
  const moving =
    view?.status === 'released' ||
    view?.status === 'settling' ||
    view?.summary.websiteProof?.status === 'checking';
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => void load(), 1_500);
    return () => {
      clearInterval(t);
    };
  }, [moving, load]);

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
          mustMatch(step.typedData, step.challenge);
          setBusy(
            `Face ID ${String(i + 1)} of ${String(steps.length)}: ${step.summary ?? k.replace('_', ' ')}`,
          );
          assertions[k] = await signChallenge(step.challenge, credentialId);
        }
        body = { action, assertions };
      } else {
        const a = view.actions[action];
        if (!a) return;
        // A proposal's refusal moves no money and has no typed data; everything else is checked.
        if (a.typedData !== null && a.typedData !== undefined) mustMatch(a.typedData, a.challenge);
        else if (action !== 'refuse') throw new Error('Nothing to check this against: not signed.');
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

  if (!view)
    return problem ? (
      <Problem text={problem} />
    ) : (
      <section className="card" aria-busy="true" aria-label="Loading">
        <Skeleton width="35%" />
        <Skeleton height={54} width="70%" />
        <Skeleton height={96} />
      </section>
    );
  const s = view.summary;
  const open = Object.keys(view.actions).length > 0;
  const failed = findings?.filter((f) => !f.ok) ?? [];
  const proposal = view.kind === 'proposal';
  const changed = view.kind === 'payment' && s.payOnce === 'address_not_on_file';
  const paid = whatIsPaid(view.actions.pay_once?.typedData);
  const missing =
    proposal && s.enoughFunds === false ? shortfall(s.amountUsdc, s.accountUsdc) : null;
  const waitingOn = view.actions.pay_once?.signatures ?? view.actions.approve_order?.signatures;
  const track = trackOf(view.kind, view.status, s.websiteProof?.status);

  return (
    <>
      <a className="back" href="/">
        <Icon name="back" /> Inbox
      </a>
      <p className="eyebrow">
        {proposal ? 'Proposed by your agent' : `Payment ${view.id.slice(2, 10).toUpperCase()}`}
        <StatusPill status={view.status} />
      </p>
      <h1>
        {proposal
          ? `Add ${s.supplierName ?? 'a supplier'}?`
          : view.status === 'held'
            ? 'Held for you'
            : view.title}
      </h1>
      {s.amountUsdc && (
        <p className="amount">
          {s.amountUsdc}
          <small>USDC</small>
        </p>
      )}

      <section className="card">
        <Track steps={track.steps} tone={track.tone} />
      </section>

      {view.kind === 'payment' && s.reasonText && view.status === 'held' && (
        <Note tone="warn" icon="alert">
          <strong>Why it is held: </strong>
          {s.reasonText}
        </Note>
      )}
      {view.kind === 'payment' && s.reasonText && view.status === 'blocked' && (
        <Note tone="bad">
          <strong>Blocked: </strong>
          {s.reasonText}
        </Note>
      )}

      {view.differences.length > 0 && (
        <section className="card bad">
          <span className="label">
            <Icon name="scan" />
            {proposal ? 'The address changes' : 'The address is not the one on file'}
          </span>
          {view.differences.map((d) => (
            <AddressCompare
              key={d.field}
              onFile={d.onFile}
              other={d.onInvoice}
              otherLabel={proposal ? 'Proposed' : 'On the invoice'}
            />
          ))}
          {view.kind === 'payment' && <Proof proof={s.websiteProof} />}
        </section>
      )}

      {changed && open && (
        <Note tone="bad" icon="lock">
          <strong>There is no “pay anyway”.</strong> This account pays only the supplier’s address
          on file, even with your Face ID. If the supplier really changed its address, your agent
          proposes the change for you to approve, and it then waits out a waiting period.
        </Note>
      )}

      {proposal && (
        <section className="card">
          <span className="label">
            <Icon name="store" /> {s.supplierName}
          </span>
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
          <Proof proof={s.websiteProof} />
          {s.changesAddress && (
            <Note tone="warn" icon="alert">
              Approving changes this supplier’s address for every order, and new payments to it wait
              out the waiting period first.
            </Note>
          )}
          {s.enoughFunds === false && (
            <Note tone="bad">
              Your account does not hold enough USDC for this order
              {missing ? `: ${missing} USDC is missing` : ''}. Only refusing is possible.
            </Note>
          )}
        </section>
      )}

      {view.kind === 'payment' && failed.length > 0 && (
        <section className="card warn">
          <span className="label">
            <Icon name="radar" /> What the checker found
          </span>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {failed.map((f, i) => (
              <li key={i}>{f.detail}</li>
            ))}
          </ul>
        </section>
      )}

      <Busy text={busy} />
      {done && !isFinal(view.status) && <Note tone="ok">{done}</Note>}
      <Waiting
        signatures={waitingOn}
        what={proposal ? 'to approve this supplier' : 'to pay this once'}
      />
      <Problem text={problem} />

      {open && (
        <section className="decide" aria-label="Your decision">
          {paid && (
            <p className="small">
              Pay once sends exactly <strong>{paid.amountUsdc} USDC</strong> to{' '}
              <Address value={paid.payTo} />, and only there.
            </p>
          )}
          <div className={`choices${Object.keys(view.actions).length === 1 ? ' one' : ''}`}>
            {view.actions.refuse && (
              <button className="danger" onClick={() => void decide('refuse')} disabled={!!busy}>
                <Icon name="x" /> Refuse
              </button>
            )}
            {view.actions.pay_once && (
              <HoldButton
                label={
                  <>
                    Pay once <Signed signatures={view.actions.pay_once.signatures} />
                  </>
                }
                hint="Hold, then Face ID"
                onConfirm={() => void decide('pay_once')}
                disabled={!!busy}
              />
            )}
            {(view.actions.approve_order ?? view.actions.set_supplier) && (
              <button className="primary" onClick={() => void decide('approve')} disabled={!!busy}>
                <Icon name="fingerprint" /> Approve{' '}
                <Signed signatures={view.actions.approve_order?.signatures} />
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

      {!open && isFinal(view.status) && (
        <Decided
          tone={view.status === 'settled' || view.status === 'approved' ? 'ok' : 'bad'}
          title={finalTitle(view.kind, view.status)}
          detail={done ?? undefined}
          hash={s.txHash}
        >
          <div className="row">
            {s.txHash && (
              <a className="button" href={explorer(s.txHash)} target="_blank" rel="noreferrer">
                <Icon name="external" /> {view.status === 'settled' ? 'Paid on Monad' : 'On Monad'}
              </a>
            )}
            {view.kind === 'payment' && (
              <a className="button" href={`/record/${view.id}`}>
                <Icon name="file" /> The full record
              </a>
            )}
          </div>
        </Decided>
      )}

      {!open && !isFinal(view.status) && view.status !== 'held' && view.status !== 'pending' && (
        <section className="card">
          <Note tone="info" icon="layers">
            {view.status === 'released' || view.status === 'settling'
              ? 'Paying on Monad: final in about a second.'
              : `Status: ${view.status}.`}
          </Note>
        </section>
      )}
    </>
  );
}

const FINAL = ['settled', 'refused', 'blocked', 'expired', 'failed', 'approved'];
const isFinal = (status: string) => FINAL.includes(status);

function finalTitle(kind: View['kind'], status: string): string {
  if (status === 'settled') return 'Paid on Monad';
  if (status === 'approved') return 'Approved';
  if (status === 'refused') return kind === 'proposal' ? 'Refused: nothing added' : 'Refused';
  if (status === 'blocked') return 'Blocked by the contract';
  if (status === 'expired') return 'Expired before anyone decided';
  return 'Not paid';
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'held' || status === 'pending'
      ? 'warn'
      : status === 'settled' || status === 'approved'
        ? 'ok'
        : status === 'refused' || status === 'blocked' || status === 'failed'
          ? 'bad'
          : 'accent';
  return <span className={`pill ${tone}`}>{status.replace('_', ' ')}</span>;
}

/** Where it is, as pipeline steps. Names the stages in plain words; no invented timings. */
function trackOf(
  kind: View['kind'],
  status: string,
  proof: string | undefined,
): { steps: Step[]; tone: 'accent' | 'warn' | 'ok' | 'bad' } {
  const d = (label: string): Step => ({ label, state: 'done' });
  const a = (label: string): Step => ({ label, state: 'active' });
  const t = (label: string): Step => ({ label, state: 'todo' });
  if (kind === 'proposal') {
    if (status === 'approved')
      return { steps: [d('Proposed'), d('Website'), d('You'), d('Live')], tone: 'ok' };
    if (status === 'pending')
      return proof === 'checking'
        ? { steps: [d('Proposed'), a('Website'), t('You'), t('Live')], tone: 'accent' }
        : { steps: [d('Proposed'), d('Website'), a('You'), t('Live')], tone: 'warn' };
    return { steps: [d('Proposed'), d(status === 'refused' ? 'Refused' : 'Closed')], tone: 'bad' };
  }
  switch (status) {
    case 'held':
      return {
        steps: [d('Requested'), d('Checked'), a('Held'), t('You'), t('Final')],
        tone: 'warn',
      };
    case 'released':
    case 'settling':
      return {
        steps: [d('Requested'), d('Checked'), d('Held'), d('You'), a('Final')],
        tone: 'accent',
      };
    case 'settled':
      return { steps: [d('Requested'), d('Checked'), d('Held'), d('You'), d('Final')], tone: 'ok' };
    case 'refused':
      return { steps: [d('Requested'), d('Checked'), d('Held'), d('Refused')], tone: 'bad' };
    case 'blocked':
      return { steps: [d('Requested'), d('Checked'), d('Blocked')], tone: 'bad' };
    default:
      return { steps: [d('Requested'), d('Checked'), d('Held'), d(status)], tone: 'bad' };
  }
}

/** What is missing for an order, in USDC, computed in base units (never floats). */
function shortfall(need?: string, have?: string): string | null {
  const units = (v?: string) => {
    if (!v || !/^\d+(\.\d{1,6})?$/.test(v)) return null;
    const [whole = '0', frac = ''] = v.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  };
  const n = units(need);
  const h = units(have);
  return n !== null && h !== null && n > h ? formatUsdc(n - h) : null;
}
