'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { call, GatewayError, problemText } from '../../../lib/gateway';
import { passkeyProblem, signChallenge } from '../../../lib/passkey';
import { loadSession } from '../../../lib/session';
import { Problem } from '../../ui';

/**
 * The run board (Slice 11, FEATURES 5): hundreds of invoices checked live, paid, held by reason,
 * and the time to final; a reason's holds refused together with one Face ID (D18).
 */

type Group = { reason: string; text: string; count: number; ids: string[] };
type Board = {
  runId: string;
  size: number;
  decided: number;
  done: boolean;
  elapsedMs: number;
  settled: { count: number; p50Ms: number | null; p95Ms: number | null };
  held: Group[];
  blocked: Group[];
};

const seconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);

export default function RunBoard() {
  const { id } = useParams<{ id: string }>();
  const [board, setBoard] = useState<Board | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/run/${id}`, { cache: 'no-store' });
    const body = (await res.json()) as Board & { error?: string; message?: string };
    if (!res.ok) setProblem(problemText(res.status, body));
    else setBoard(body);
    return body;
  }, [id]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const b = await load().catch(() => null);
      if (!stop && !b?.done) setTimeout(() => void tick(), 1_500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [load]);

  async function refuseAll(reason: string) {
    setProblem(null);
    try {
      const group = (
        await call<{ challenge: string | null; summary: string; count: number }>(
          `/v1/approvals/runs/${id}?reason=${reason}`,
        )
      ).body;
      if (!group.challenge) return;
      setBusy(`Face ID: ${group.summary}`);
      const assertion = await signChallenge(group.challenge, loadSession().credentialId);
      const done = await call<{ refused: number }>(`/v1/approvals/runs/${id}?reason=${reason}`, {
        method: 'POST',
        body: { assertion },
      });
      setNote(`Refused ${String(done.body.refused)}. Nothing was paid.`);
      void load();
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : passkeyProblem(e));
    } finally {
      setBusy(null);
    }
  }

  if (!board) return <Problem text={problem} />;
  const held = board.held.reduce((n, g) => n + g.count, 0);
  const blocked = board.blocked.reduce((n, g) => n + g.count, 0);
  // Refused by the owner, expired before anyone decided, or failed: decided, but none of the above.
  const other = board.decided - board.settled.count - held - blocked;
  const pct = (n: number) => `${String((n / Math.max(1, board.size)) * 100)}%`;

  return (
    <>
      <p className="small muted">Payment run</p>
      <h1>
        {board.done ? 'Done' : 'Checking'}: {board.decided} of {board.size} decided
      </h1>
      <div className="bar-track" aria-hidden="true">
        <span style={{ width: pct(board.settled.count), background: 'var(--ok)' }} />
        <span style={{ width: pct(held), background: 'var(--warn)' }} />
        <span style={{ width: pct(blocked), background: 'var(--danger)' }} />
      </div>
      <section className="card">
        <dl className="kv">
          <dt>Paid</dt>
          <dd>{board.settled.count}</dd>
          <dt>Held for you</dt>
          <dd>{held}</dd>
          <dt>Blocked</dt>
          <dd>{blocked}</dd>
          {other > 0 && (
            <>
              <dt>Refused or expired</dt>
              <dd>{other}</dd>
            </>
          )}
          <dt>Each paid, request to final</dt>
          <dd>
            median {seconds(board.settled.p50Ms)}, 95% within {seconds(board.settled.p95Ms)}
          </dd>
          <dt>{board.done ? 'Last decision' : 'So far'}</dt>
          <dd>{seconds(board.elapsedMs)} after intake</dd>
        </dl>
      </section>
      {busy && (
        <p className="note ok" aria-live="polite">
          {busy}
        </p>
      )}
      {note && <p className="note ok">{note}</p>}
      <Problem text={problem} />
      {board.held.map((g) => (
        <section className="card" key={g.reason}>
          <h2>
            {g.count} held: {g.text}
          </h2>
          <div className="list">
            {g.ids.slice(0, 5).map((pid) => (
              <a className="item small" key={pid} href={`/approve/${pid}`}>
                Open {pid.slice(0, 10)}…
              </a>
            ))}
            {g.ids.length > 5 && <p className="small muted">and {g.ids.length - 5} more</p>}
          </div>
          <button className="danger" onClick={() => void refuseAll(g.reason)} disabled={!!busy}>
            Refuse all {g.count} with one Face ID
          </button>
        </section>
      ))}
      {board.blocked.map((g) => (
        <section className="card" key={g.reason}>
          <h2>
            {g.count} blocked: {g.text}
          </h2>
          <p className="small muted">The account’s contract refuses these; nothing to decide.</p>
        </section>
      ))}
    </>
  );
}
