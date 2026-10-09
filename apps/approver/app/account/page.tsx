'use client';
import { useCallback, useEffect, useState } from 'react';
import { call, GatewayError } from '../../lib/gateway';
import { createPasskey, passkeyProblem, signChallenge } from '../../lib/passkey';
import { loadSession } from '../../lib/session';
import { mustMatch } from '../../lib/verify';
import { Problem, Signed } from '../ui';

/**
 * The account (Slice 11): the stop button (FEATURES 9) and several approvers (FEATURES 8, D36).
 * Any one owner can pause; unpausing and changing owners need the account's manage threshold, and
 * the screen says who has signed. Everything is signed with Face ID and checked by the contract.
 */

type Key = { qx: string; qy: string };
type Change = {
  challenge: string;
  typedData: unknown;
  deadline: number;
  owners: Key[];
  manage: number;
  release: number;
  summary: string;
  signatures: { need: number; signed: number[] };
};
type Owner = {
  account: string;
  paused: boolean;
  owners: (Key & { owner: number })[];
  manage: number;
  release: number;
  actions: Record<
    string,
    {
      challenge: string;
      deadline: number;
      summary: string;
      typedData: unknown;
      signatures?: { need: number; signed: number[] };
    }
  >;
  ownerChanges: Change[];
};

const message = (e: unknown) => (e instanceof GatewayError ? e.message : passkeyProblem(e));

export default function Account() {
  const [account, setAccount] = useState<string | null>(null);
  const [state, setState] = useState<Owner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [manage, setManage] = useState(1);
  const [release, setRelease] = useState(1);

  const load = useCallback(async (a: string) => {
    try {
      const s = (await call<Owner>(`/v1/owner/${a}`)).body;
      setState(s);
      setManage(s.manage);
      setRelease(s.release);
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  useEffect(() => {
    const a = loadSession().account;
    setAccount(a);
    if (a) void load(a);
  }, [load]);

  async function toggle(action: 'pause' | 'unpause') {
    if (!state || !account) return;
    const a = state.actions[action];
    if (!a) return;
    setProblem(null);
    try {
      mustMatch(a.typedData, a.challenge);
      setBusy(`Face ID: ${a.summary}`);
      const assertion = await signChallenge(a.challenge, loadSession().credentialId);
      setBusy('Checking with the account on Monad…');
      const r = await call<Owner>(`/v1/owner/${account}`, {
        method: 'POST',
        body: { action, deadline: a.deadline, assertion },
      });
      setNote(
        r.status === 202
          ? 'Your signature is counted. Another owner needs to sign to unpause.'
          : action === 'pause'
            ? 'Paused. No payment leaves this account until it is unpaused.'
            : 'Unpaused. Payments inside your rules go out again.',
      );
      await load(account);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  }

  /** Signs an owner change (a new one from the preview, or one another owner started). */
  async function signChange(change: Change, owners: unknown[]) {
    if (!account) return;
    mustMatch(change.typedData, change.challenge);
    setBusy(`Face ID: ${change.summary}`);
    const assertion = await signChallenge(change.challenge, loadSession().credentialId);
    setBusy('Checking with the account on Monad…');
    const r = await call<Owner>(`/v1/owner/${account}/owners`, {
      method: 'POST',
      body: {
        owners,
        manage: change.manage,
        release: change.release,
        deadline: change.deadline,
        assertion,
      },
    });
    setNote(
      r.status === 202
        ? 'Your signature is counted. Another owner needs to sign this change.'
        : 'Done: the account’s owners are updated on Monad.',
    );
    await load(account);
  }

  async function change(withNewKey: boolean) {
    if (!state || !account) return;
    setProblem(null);
    try {
      const owners: unknown[] = state.owners.map((o) => ({ x: o.qx, y: o.qy }));
      if (withNewKey) {
        setBusy('Making the new approver’s passkey on this phone…');
        const key = await createPasskey(`Countersign approver ${String(state.owners.length + 1)}`);
        owners.push({ spki: key.spki });
      }
      const preview = (
        await call<Change>(`/v1/owner/${account}/owners/preview`, {
          method: 'POST',
          body: { owners, manage, release },
        })
      ).body;
      await signChange(preview, owners);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function cosign(c: Change) {
    setProblem(null);
    try {
      await signChange(
        c,
        c.owners.map((o) => ({ x: o.qx, y: o.qy })),
      );
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  }

  if (!account)
    return (
      <p className="note warn">
        Open your account on the <a href="/">home screen</a> first.
      </p>
    );
  if (!state) return <Problem text={problem} />;
  const n = state.owners.length;
  const options = (max: number) =>
    Array.from({ length: max }, (_, i) => (
      <option key={i + 1} value={i + 1}>
        {i + 1} of {max}
      </option>
    ));

  return (
    <>
      <h1>Your account</h1>
      <p className="small muted addr">{account}</p>
      {busy && (
        <p className="note ok" aria-live="polite">
          {busy}
        </p>
      )}
      {note && <p className="note ok">{note}</p>}
      <Problem text={problem} />

      <section className="card">
        <h2>{state.paused ? 'Paused: no payment leaves this account' : 'Payments are running'}</h2>
        <p className="small muted">
          {state.paused
            ? 'Unpausing needs the account’s owners to sign.'
            : 'Any one owner can stop every payment at once.'}
        </p>
        {state.actions.pause && (
          <button className="danger" onClick={() => void toggle('pause')} disabled={!!busy}>
            Stop every payment
          </button>
        )}
        {state.actions.unpause && (
          <button className="primary" onClick={() => void toggle('unpause')} disabled={!!busy}>
            Unpause <Signed signatures={state.actions.unpause.signatures} />
          </button>
        )}
      </section>

      <section className="card">
        <h2>Approvers</h2>
        <p className="small muted">
          {n} owner{n === 1 ? '' : 's'}. Adding a supplier or an order, changing owners and
          unpausing need {state.manage}; paying a held payment once needs {state.release}. Any one
          can refuse or pause.
        </p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {state.owners.map((o) => (
            <li key={o.owner}>
              Owner {o.owner + 1}: passkey <span className="addr">{o.qx.slice(0, 10)}…</span>
            </li>
          ))}
        </ul>
        <label>
          Needed to manage
          <select
            id="manage"
            value={manage}
            onChange={(e) => {
              setManage(Number(e.target.value));
            }}
          >
            {options(n)}
          </select>
        </label>
        <label>
          Needed to pay a held payment once
          <select
            id="release"
            value={release}
            onChange={(e) => {
              setRelease(Number(e.target.value));
            }}
          >
            {options(n)}
          </select>
        </label>
        <div className="choices">
          <button onClick={() => void change(true)} disabled={!!busy || n >= 5}>
            Add an approver (a new passkey on this phone)
          </button>
          <button
            onClick={() => void change(false)}
            disabled={!!busy || (manage === state.manage && release === state.release)}
          >
            Save the thresholds
          </button>
        </div>
        <p className="small muted">
          To add someone else, they make a passkey on their own phone; for a demo, a second passkey
          on this phone works.
        </p>
      </section>

      {state.ownerChanges.length > 0 && (
        <section className="card">
          <h2>Waiting for another owner</h2>
          {state.ownerChanges.map((c) => (
            <div key={c.challenge} className="item">
              <span className="small">{c.summary}</span>
              <Signed signatures={c.signatures} />
              <button onClick={() => void cosign(c)} disabled={!!busy}>
                Sign with Face ID
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
