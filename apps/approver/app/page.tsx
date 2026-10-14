'use client';
import { useCallback, useEffect, useState } from 'react';
import { call, GatewayError } from '../lib/gateway';
import { createPasskey, passkeyProblem, passkeysAvailable, signChallenge } from '../lib/passkey';
import { forgetSession, loadSession, saveSession, type Session } from '../lib/session';
import { mustMatch } from '../lib/verify';
import { Busy, Orbit, Skeleton, type Journey } from './fx';
import { Icon } from './icons';
import { explorer, Note, Problem } from './ui';

/**
 * Home (Slice 11): what waits for the owner (the inbox), and, for a judge or anyone new, their own
 * testnet account from their phone's passkey (judge mode, FEATURES 7), with the demo agent paying
 * clean and doctored invoices into it.
 */

type DemoAccount = {
  account: string;
  status: 'creating' | 'awaiting_passkey' | 'setting_up' | 'ready';
  actions: { action: string; summary: string; challenge: string; typedData: unknown }[];
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

// Judge mode's prompts, named short enough for four across a phone (13 Oct).
const STEP_NAMES: Record<string, string> = {
  setPolicy: 'Rules',
  setSupplier: 'Supplier',
  approveOrder: 'Order',
};
const FIRST_STEPS = ['Passkey', 'Rules', 'Supplier', 'Order'];

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [demo, setDemo] = useState<DemoAccount | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  // Why the inbox could not be read, so a failure is said rather than "Reading…" forever (9 Oct).
  const [inboxProblem, setInboxProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // While a test account is made: its prompts as one flow, "Step 2 of 4" (null otherwise).
  const [journey, setJourney] = useState<Journey | null>(null);
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
        setInboxProblem(null);
      } catch (e) {
        if (e instanceof GatewayError && e.status === 401) setSession(saveSession({ token: null }));
        else setInboxProblem(message(e));
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
    let steps = FIRST_STEPS;
    try {
      setJourney({ steps, done: 0, signing: true });
      setBusy('Make a passkey on this phone. It is the only key to your test account.');
      const key = await createPasskey(`Countersign test ${new Date().toISOString().slice(0, 10)}`);
      setJourney({ steps, done: 1, signing: false });
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
      // The steps the gateway actually asks for, so the count never promises a prompt that won't come.
      steps = ['Passkey', ...created.actions.map((a) => STEP_NAMES[a.action] ?? a.action)];
      const assertions = [];
      for (const [i, a] of created.actions.entries()) {
        mustMatch(a.typedData, a.challenge);
        setJourney({ steps, done: i + 1, signing: true });
        // The plain-words summary of exactly what this prompt signs, checked just above.
        setBusy(a.summary);
        assertions.push(await signChallenge(a.challenge, key.credentialId));
      }
      let token: string | undefined;
      if (assertions.length > 0) {
        setJourney({ steps, done: steps.length, signing: false });
        setBusy('Setting up the account on Monad (about 4 s)…');
        const ready = (
          await call<DemoAccount & { token?: string }>(
            `/v1/demo/accounts/${created.account}/setup`,
            { method: 'POST', body: { assertions } },
          )
        ).body;
        setDemo(ready);
        token = ready.token;
      }
      // The setup answers with this phone's token (9 Oct): no fifth prompt. Only an account set up
      // earlier (no setup now) still needs one signature for it.
      if (token) s = saveSession({ token });
      else {
        setJourney(null);
        setBusy('One more confirmation to connect this phone to the account…');
        s = await connectPhone(s);
      }
      setSession(s);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setJourney(null);
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
        <section className="hero">
          <p className="eyebrow">
            <span className="ping" aria-hidden="true" /> Agent payment control
          </p>
          <h1>
            AI agents can pay. <em>Only what you approved goes out.</em>
          </h1>
          <p className="lede">
            Your agent pays approved suppliers on its own. Anything else waits here for you: a new
            address, a padded invoice, a supplier you never approved. You decide with Face ID.
          </p>
          <Orbit />
        </section>

        <section className="card">
          <span className="label">
            <Icon name="fingerprint" /> Try it · judge mode
          </span>
          <h2>Your own testnet account, from this phone’s passkey</h2>
          <p className="small muted">
            0.01 test USDC and an order with the demo supplier. No wallet, nothing to install.
          </p>
          <ol className="steps">
            <li>
              <span>
                <strong>Make a passkey</strong> on this phone (Face ID, fingerprint or screen lock).
              </span>
            </li>
            <li>
              <span>
                <strong>Approve your agent’s rules</strong>, checked by the contract on Monad.
              </span>
            </li>
            <li>
              <span>
                <strong>Approve the supplier</strong> and the only address it is paid at.
              </span>
            </li>
            <li>
              <span>
                <strong>Open the order.</strong> Then have the demo agent pay invoices into it.
              </span>
            </li>
          </ol>
          {passkeysAvailable() ? (
            <button className="primary" onClick={() => void createAccount()} disabled={!!busy}>
              <Icon name="fingerprint" /> Create my test account
            </button>
          ) : (
            <Note tone="warn">
              This browser cannot use passkeys. Open this page in Safari or Chrome on your phone.
            </Note>
          )}
          <p className="small muted">
            Monad testnet, test USDC. Demo accounts have no waiting period for new suppliers; real
            accounts wait 48 hours.
          </p>
        </section>

        <section className="card">
          <span className="label">
            <Icon name="user" /> Open an account you own
          </span>
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
            Open <Icon name="arrow" />
          </button>
        </section>
        <Busy text={busy} journey={journey} />
        <Problem text={problem} />
      </>
    );

  const waiting = (inbox?.held.length ?? 0) + (inbox?.proposals.length ?? 0);
  return (
    <>
      <p className="eyebrow">
        <span className="ping" aria-hidden="true" /> Inbox · live
      </p>
      <h1>{waiting > 0 ? `${String(waiting)} waiting for you` : 'Nothing waiting'}</h1>
      <p className="small muted addr">Account {session.account}</p>
      <Busy text={busy} />
      <Problem text={problem} />

      {!session.token ? (
        <section className="card">
          <span className="label">
            <Icon name="lock" /> Connect this phone
          </span>
          <p className="small muted">
            One Face ID gives this phone a key that reads only this account: what is held, its
            orders and records.
          </p>
          <button className="primary" onClick={() => void connect()} disabled={!!busy}>
            <Icon name="fingerprint" /> Connect with Face ID
          </button>
        </section>
      ) : (
        <section className={`card${waiting > 0 ? ' warn' : ''}`}>
          <div className="card-head">
            <span className="label">
              <Icon name="inbox" /> Waiting for you
            </span>
            {waiting > 0 && <span className="pill warn">{waiting}</span>}
          </div>
          {inbox === null ? (
            inboxProblem ? (
              <Note tone="warn">
                Could not read what is waiting: {inboxProblem} Trying again every few seconds.
              </Note>
            ) : (
              <div className="list" aria-label="Reading">
                <Skeleton height={58} />
                <Skeleton height={58} />
              </div>
            )
          ) : waiting === 0 ? (
            <Note tone="ok" icon="shieldCheck">
              Nothing is held and nothing is proposed. Payments inside your rules are paid without
              asking you.
            </Note>
          ) : (
            <div className="list">
              {inbox.proposals.map((p) => (
                <a className="item proposal" key={p.id} href={`/approve/${p.id}`}>
                  <span className="row-top">
                    <strong>New supplier: {p.supplierName}</strong>
                    <span className="money">{p.amountUsdc} USDC</span>
                  </span>
                  <span className="small muted">An order proposed by your agent · review</span>
                </a>
              ))}
              {inbox.held.map((h) => (
                <a className="item held" key={h.id} href={`/approve/${h.id}`}>
                  <span className="row-top">
                    <strong>{h.supplierName ?? 'A payment'}</strong>
                    <span className="money">{h.amountUsdc} USDC</span>
                  </span>
                  <span className="small muted">
                    <span className="pill warn">
                      <Icon name="pause" /> Held
                    </span>{' '}
                    {h.reasonText ?? 'needs you'}
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {demo?.status === 'ready' && (
        <section className="card">
          <span className="label">
            <Icon name="bolt" /> The demo agent
          </span>
          <p className="small muted">
            From your {demo.order?.amountUsdc ?? '0.005'} USDC order with{' '}
            {demo.order?.supplier ?? 'Kalibre Studio'}, 0.001 USDC each. A clean one is paid in
            about 2 s; the other two are held for you.
          </p>
          <div className="list">
            <button
              className="agent-btn clean"
              onClick={() => void demoInvoice('clean')}
              disabled={!!busy}
            >
              <Icon name="check" />
              <span>
                <strong>A clean invoice</strong>
                <small>Matches the order. Paid with nobody asked.</small>
              </span>
              <Icon name="arrow" />
            </button>
            <button
              className="agent-btn fake"
              onClick={() => void demoInvoice('changed_address')}
              disabled={!!busy}
            >
              <Icon name="alert" />
              <span>
                <strong>New payment details</strong>
                <small>A look-alike address. Held; only refusing is possible.</small>
              </span>
              <Icon name="arrow" />
            </button>
            <button
              className="agent-btn padded"
              onClick={() => void demoInvoice('amount_mismatch')}
              disabled={!!busy}
            >
              <Icon name="file" />
              <span>
                <strong>A padded price</strong>
                <small>Over the quote. Held; pay once or refuse.</small>
              </span>
              <Icon name="arrow" />
            </button>
          </div>
          {paid.length > 0 && (
            <div className="list" aria-live="polite">
              {paid.map((p) => (
                <div className={`item${p.status === 'held' ? ' held' : ''}`} key={p.requestId}>
                  <span className="row-top">
                    <strong>
                      {p.status === 'settled'
                        ? 'Paid'
                        : p.status === 'held'
                          ? 'Held for you'
                          : p.status}
                    </strong>
                    <span
                      className={`pill ${p.status === 'settled' ? 'ok' : p.status === 'held' ? 'warn' : 'bad'}`}
                    >
                      <Icon
                        name={
                          p.status === 'settled' ? 'check' : p.status === 'held' ? 'pause' : 'x'
                        }
                      />
                      {p.status}
                    </span>
                  </span>
                  {p.reasonText && <span className="small muted">{p.reasonText}</span>}
                  <span className="row">
                    {p.status === 'held' && (
                      <a href={`/approve/${p.requestId}`}>
                        Decide with Face ID <Icon name="arrow" />
                      </a>
                    )}
                    {p.txHash && (
                      <a href={explorer(p.txHash)} target="_blank" rel="noreferrer">
                        See it on Monad
                      </a>
                    )}
                    <a href={`/record/${p.requestId}`}>The record</a>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {demo && demo.status !== 'ready' && (
        <Note tone="warn">
          This account is still being set up ({demo.status.replace('_', ' ')}).
        </Note>
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
