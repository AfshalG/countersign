'use client';
import { useEffect, useState } from 'react';
import { call, GatewayError } from '../../lib/gateway';
import { passkeyProblem, signChallenge } from '../../lib/passkey';
import { loadSession } from '../../lib/session';
import { Problem } from '../ui';

/**
 * Connect (Slice 11, FEATURES 6 and 11): how to give an agent this account (MCP, A2A, the SDK), and
 * approvals on WhatsApp: one Face ID, then WhatsApp opens with the code typed for the person to
 * send. WhatsApp is off on the gateway until its test number is set up; the button says so.
 */

const MCP = 'https://countersign-mcp.vercel.app/api/mcp';
const CARD = 'https://countersign-mcp.vercel.app/.well-known/agent-card.json';
const SDK = 'https://github.com/AfshalG/countersign/releases/tag/sdk-v0.3.0';

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="small"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
          })
          .catch(() => {
            setDone(false);
          });
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export default function Connect() {
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    setAccount(loadSession().account);
  }, []);

  async function whatsapp() {
    if (!account) return;
    setProblem(null);
    try {
      let code: { code: string; challenge: string };
      try {
        code = (
          await call<{ code: string; challenge: string }>('/v1/whatsapp/codes', {
            method: 'POST',
            body: { account },
          })
        ).body;
      } catch (e) {
        if (e instanceof GatewayError && e.status !== 404) throw e;
        setProblem('Approvals on WhatsApp are not switched on yet.');
        return;
      }
      setBusy('Face ID to connect WhatsApp…');
      const assertion = await signChallenge(code.challenge, loadSession().credentialId);
      const got = await call<{ link: string }>(`/v1/whatsapp/codes/${code.code}`, {
        method: 'POST',
        body: { assertion },
      });
      setLink(got.body.link);
      window.location.href = got.body.link;
    } catch (e) {
      setProblem(
        e instanceof TypeError
          ? 'Approvals on WhatsApp are not switched on yet.'
          : e instanceof GatewayError
            ? e.message
            : passkeyProblem(e),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1>Connect your agent</h1>
      <section className="card">
        <h2>Claude, Grok, ChatGPT and other MCP apps</h2>
        <p className="small muted">
          Add Countersign as a custom connector and sign in. Six tools: list orders, check, pay, pay
          a run, look up a status, propose an order.
        </p>
        <div className="row">
          <span className="addr">{MCP}</span>
          <Copy text={MCP} />
        </div>
      </section>
      <section className="card">
        <h2>Agents on Google’s Agent2Agent (A2A)</h2>
        <p className="small muted">
          A held payment comes back as an `auth-required` task with your approval link.
        </p>
        <a href={CARD} target="_blank" rel="noreferrer">
          The Agent Card
        </a>
      </section>
      <section className="card">
        <h2>Your own agent, in TypeScript</h2>
        <p className="small muted">
          The SDK signs with your agent’s key on your machine.
          {account ? ' Your account:' : ''}
        </p>
        {account && (
          <div className="row">
            <span className="addr">{account}</span>
            <Copy text={account} />
          </div>
        )}
        <a href={SDK} target="_blank" rel="noreferrer">
          SDK 0.3.0
        </a>
      </section>
      <section className="card">
        <h2>Approvals on WhatsApp</h2>
        <p className="small muted">
          Held payments and proposed suppliers arrive on WhatsApp with a button that opens the same
          approval screen; Face ID still signs here.
        </p>
        <button onClick={() => void whatsapp()} disabled={!account || !!busy}>
          Connect WhatsApp
        </button>
        {busy && <p className="note ok">{busy}</p>}
        {link && (
          <a href={link} className="button">
            Open WhatsApp
          </a>
        )}
        <Problem text={problem} />
      </section>
    </>
  );
}
