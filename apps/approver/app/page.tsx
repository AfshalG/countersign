'use client';
import { useCallback, useEffect, useState } from 'react';
import { call, GatewayError } from '../lib/gateway';
import { createPasskey, passkeyProblem, passkeysAvailable, signChallenge } from '../lib/passkey';
import { forgetSession, loadSession, saveSession, type Session } from '../lib/session';
import { explorer, Problem } from './ui';

/**
 * Home (Slice 11): what waits for the owner (the inbox), and, for a judge or anyone new, their own
 * testnet account from their phone's passkey (judge mode, FEATURES 7), with the demo agent paying
 * clean and doctored invoices into it.
 */

type DemoAccount = {
  account: string;
  status: 'creating' | 'awaiting_passkey' | 'setting_up' | 'ready';
  actions: { action: string; summary: string; challenge: string }[];
  order: { supplier: string; amountUsdc: string } | null;
  fundedUsdc: string;
};
type Inbox = {
  held: {
    id: string;
    amountUsdc: string;
    supplierName: string | null;
    reasonText: string | null;
    runId: string | null;
  }[];
  proposals: { id: string; supplierName: string; amountUsdc: string }[];
};
type Paid = {
  kind: string;
  requestId: string;
  status: string;
  reasonText: string | null;
  txHash: string | null;
};

const message = (e: unknown) => (e instanceof GatewayError ? e.message : passkeyProblem(e));

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [demo, setDemo] = useState<DemoAccount | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [paid, setPaid] = useState<Paid[]>([]);
  const [address, setAddress] = useState('');

  useEffect(() => {
    setSession(loadSession());
  }, []);

  // The account's state (judge-mode accounts) and its inbox (with this phone's token), kept fresh.
  const refresh = useCallback(async (s: Session) => {
    if (!s.account) return;
    try {
      setDemo((await call<DemoAccount>(`/v1/demo/accounts/${s.account}`)).body);
    } catch {
      setDemo(null); // not a judge-mode account: the inbox still works with a token
    }
    if (s.token)
      try {
        setInbox((await call<Inbox>(`/v1/accounts/${s.account}/inbox`, { token: s.token })).body);
      } catch (e) {
        if (e instanceof GatewayError && e.status === 401) setSession(saveSession({ token: null }));
      }
  }, []);
  useEffect(() => {
    if (!session?.account) return;
    void refresh(session);
    const t = setInterval(() => void refresh(session), 3_000);
    return () => {
      clearInterval(t);
    };
  }, [session, refresh]);

  /** One Face ID: a token that reaches only this account, kept on this phone (S11-1). */
  async function connectPhone(s: Session) {
    const account = s.account ?? '';
    const ask = await call<{ challenge: string }>(`/v1/demo/accounts/${account}/token`);
    const assertion = await signChallenge(ask.body.challenge, s.credentialId);
    const got = await call<{ token: string }>(`/v1/demo/accounts/${account}/token`, {
      method: 'POST',
      body: { assertion },
    });
    return saveSession({ token: got.body.token });
  }

  async function createAccount() {
    setProblem(null);
    try {
      setBusy('Making a passkey on this phone…');
      const key = await createPasskey(`Countersign test ${new Date().toISOString().slice(0, 10)}`);
      setBusy('Creating your account on Monad (about 3 s)…');
      const created = (
        await call<DemoAccount>('/v1/demo/accounts', {
          method: 'POST',
          body: { publicKey: { spki: key.spki } },
        })
      ).body;
      let s = saveSession({
        account: created.account,
        credentialId: key.credentialId,
        token: null,
      });
      setSession(s);
      setDemo(created);
      const assertions = [];
      for (const [i, a] of created.actions.entries()) {
        setBusy(`Face ID ${String(i + 1)} of ${String(created.actions.length)}: ${a.summary}`);
        assertions.push(await signChallenge(a.challenge, key.credentialId));
      }
      if (assertions.length > 0) {
        setBusy('Setting up the account on Monad (about 4 s)…');
        setDemo(
          (
            await call<DemoAccount>(`/v1/demo/accounts/${created.account}/setup`, {
              method: 'POST',
              body: { assertions },
            })
          ).body,
        );
      }
      setBusy('One more Face ID to connect this phone to the account…');
      s = await connectPhone(s);
      setSession(s);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  }

  function openAccount() {
    setProblem(null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) {
      setProblem('That is not an account address (0x and 40 characters).');
      return;
    }
    setSession(saveSession({ account: address.trim(), token: null }));
  }

  async function connect() {
    if (!session) return;
    setProblem(null);
    setBusy('Face ID to connect this phone…');
    try {
      setSession(await connectPhone(session));
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function demoInvoice(kind: 'clean' | 'changed_address' | 'amount_mismatch') {
    if (!session?.account) return;
    setProblem(null);
    setBusy('The demo agent is paying an invoice…');
    try {
      const r = await call<Paid>(`/v1/demo/accounts/${session.account}/invoices`, {
        method: 'POST',
        body: { kind },
      });
      setPaid((p) => [r.body, ...p]);
      void refresh(session);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  }

  if (!session) return null;

  if (!session.account)
    return (
      <>
        <h1>Approve your agent’s payments with Face ID</h1>
        <p className="muted">
          Your AI agent pays approved suppliers on its own. Anything else waits here for you: a new
          address, a padded invoice, a supplier you never approved.
        </p>
        <section className="card">
          <h2>Try it with your own account</h2>
          <p className="small muted">
            A testnet account made from this phone’s passkey, with 0.01 test USDC and an order with
            the demo supplier. No wallet, nothing to install. Five Face ID prompts.
          </p>
          {passkeysAvailable() ? (
            <button className="primary" onClick={() => void createAccount()} disabled={!!busy}>
              Create my test account
            </button>
          ) : (
            <p className="note warn">
              This browser cannot use passkeys. Open this page in Safari or Chrome on your phone.
            </p>
          )}
        </section>
        <section className="card">
          <h2>Open an account you own</h2>
          <label>
            Account address
            <input
              id="account-address"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
              }}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button onClick={openAccount} disabled={!!busy}>
            Open
          </button>
        </section>
        {busy && (
          <p className="note ok" aria-live="polite">
            {busy}
          </p>
        )}
        <Problem text={problem} />
      </>
    );

  const waiting = (inbox?.held.length ?? 0) + (inbox?.proposals.length ?? 0);
  return (
    <>
      <h1>{waiting > 0 ? `${String(waiting)} waiting for you` : 'Nothing waiting'}</h1>
      <p className="small muted addr">Account {session.account}</p>
      {busy && (
        <p className="note ok" aria-live="polite">
          {busy}
        </p>
      )}
      <Problem text={problem} />

      {!session.token ? (
        <section className="card">
          <h2>Connect this phone</h2>
          <p className="small muted">
            One Face ID gives this phone a key that reads only this account: what is held, its
            orders and records.
          </p>
          <button className="primary" onClick={() => void connect()} disabled={!!busy}>
            Connect with Face ID
          </button>
        </section>
      ) : (
        <section className="card">
          <h2>Waiting for you</h2>
          {inbox === null ? (
            <p className="muted small">Reading…</p>
          ) : waiting === 0 ? (
            <p className="muted small">
              Nothing is held and nothing is proposed. Payments inside your rules are paid without
              asking you.
            </p>
          ) : (
            <div className="list">
              {inbox.proposals.map((p) => (
                <a className="item" key={p.id} href={`/approve/${p.id}`}>
                  <strong>New supplier: {p.supplierName}</strong>
                  <span className="small muted">
                    An order for {p.amountUsdc} USDC, proposed by your agent
                  </span>
                </a>
              ))}
              {inbox.held.map((h) => (
                <a className="item" key={h.id} href={`/approve/${h.id}`}>
                  <strong>
                    {h.amountUsdc} USDC{h.supplierName ? ` for ${h.supplierName}` : ''}
                  </strong>
                  <span className="small muted">Held: {h.reasonText ?? 'needs you'}</span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {demo?.status === 'ready' && (
        <section className="card">
          <h2>Have the demo agent pay an invoice</h2>
          <p className="small muted">
            From your {demo.order?.amountUsdc ?? '0.005'} USDC order with{' '}
            {demo.order?.supplier ?? 'Kalibre Studio'}, 0.001 USDC each. A clean one is paid in
            about 2 s; the other two are held for you.
          </p>
          <div className="choices one">
            <button onClick={() => void demoInvoice('clean')} disabled={!!busy}>
              A clean invoice
            </button>
            <button onClick={() => void demoInvoice('changed_address')} disabled={!!busy}>
              New payment details (a look-alike address)
            </button>
            <button onClick={() => void demoInvoice('amount_mismatch')} disabled={!!busy}>
              A padded price
            </button>
          </div>
          {paid.length > 0 && (
            <div className="list">
              {paid.map((p) => (
                <div className="item" key={p.requestId}>
                  <strong>
                    {p.status === 'settled'
                      ? 'Paid'
                      : p.status === 'held'
                        ? 'Held for you'
                        : p.status}
                  </strong>
                  {p.reasonText && <span className="small muted">{p.reasonText}</span>}
                  {p.status === 'held' && (
                    <a href={`/approve/${p.requestId}`}>Decide with Face ID</a>
                  )}
                  {p.txHash && (
                    <a href={explorer(p.txHash)} target="_blank" rel="noreferrer">
                      See it on Monad
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {demo && demo.status !== 'ready' && (
        <p className="note warn">
          This account is still being set up ({demo.status.replace('_', ' ')}).
        </p>
      )}

      <button
        onClick={() => {
          forgetSession();
          setSession(loadSession());
          setInbox(null);
          setDemo(null);
        }}
      >
        Use another account
      </button>
    </>
  );
}
