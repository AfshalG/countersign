'use client';
import { useState, type ReactNode } from 'react';
import { markDifferences } from '../lib/diff';
import { Icon, type IconName } from './icons';

/** An address in full, with the characters that differ from `against` marked (FEATURES' rule). */
export function Address({ value, against }: { value: string; against?: string | null }) {
  if (!against) return <span className="addr">{value}</span>;
  return (
    <span className="addr">
      {markDifferences(value, against).map((p, i) =>
        p.differs ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </span>
  );
}

type Signatures = { need: number; signed: number[] } | undefined;

/** "1 of 2 signed" for an action that needs several owners (D36). */
export function Signed({ signatures }: { signatures?: Signatures }) {
  if (!signatures || signatures.need <= 1) return null;
  return (
    <span className="pill">
      <Icon name="users" />
      {signatures.signed.length} of {signatures.need} signed
    </span>
  );
}

/**
 * The waiting state (FEATURES 8): who signed, how many more are needed, and a way to send the
 * same link to the next owner. Owners have no names on chain, so they are numbered.
 */
export function Waiting({ signatures, what }: { signatures?: Signatures; what: string }) {
  const [shared, setShared] = useState<string | null>(null);
  if (!signatures || signatures.need <= 1 || signatures.signed.length === 0) return null;
  if (signatures.signed.length >= signatures.need) return null;
  const more = signatures.need - signatures.signed.length;
  async function share() {
    const url = window.location.href;
    try {
      // Not every browser can share (desktop Firefox): copy the link there instead.
      const nav: Partial<Navigator> = navigator;
      if (nav.share) {
        await nav.share({ title: 'Countersign', text: `Please sign: ${what}`, url });
        setShared('Shared.');
      } else {
        await navigator.clipboard.writeText(url);
        setShared('Link copied. Send it to another owner.');
      }
    } catch {
      setShared(`Send this link to another owner: ${url}`);
    }
  }
  return (
    <section className="card warn">
      <div className="card-head">
        <span className="label">
          <Icon name="users" /> Waiting for another owner
        </span>
        <span className="pill warn">
          {signatures.signed.length} of {signatures.need} signed
        </span>
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {signatures.signed.map((o) => (
          <li key={o}>Owner {o + 1} signed</li>
        ))}
        <li>
          {more} more owner{more === 1 ? '' : 's'} must sign {what}
        </li>
      </ul>
      <button type="button" onClick={() => void share()}>
        <Icon name="share" /> Send the link to another owner
      </button>
      {shared && <p className="small muted">{shared}</p>}
    </section>
  );
}

export function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="note bad" role="alert">
      <Icon name="alert" />
      <span>{text}</span>
    </p>
  );
}

/** A note with its meaning said twice: an icon and words (never colour alone). */
export function Note({
  tone,
  icon,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'info';
  icon?: IconName;
  children: ReactNode;
}) {
  const fallback: Record<typeof tone, IconName> = {
    ok: 'check',
    warn: 'clock',
    bad: 'alert',
    info: 'shield',
  };
  return (
    <p className={`note ${tone}`}>
      <Icon name={icon ?? fallback[tone]} />
      <span>{children}</span>
    </p>
  );
}

type WebsiteProof = {
  status: string;
  site?: string | null;
  text: string;
  txHash?: string | null;
};

/**
 * What the supplier's own website lists (Slice 15), on proposals and changed-address holds.
 * `verified` reassures; `not_listed` is a strong warning; `stale` and `unavailable` ask the owner
 * to check with the supplier; `checking` lasts a few seconds (the screen polls).
 */
export function Proof({ proof }: { proof: WebsiteProof | null | undefined }) {
  if (!proof) return null;
  const tone: Record<string, { tone: 'ok' | 'warn' | 'bad'; icon: IconName; head: string }> = {
    verified: { tone: 'ok', icon: 'shieldCheck', head: 'Verified on the supplier’s website' },
    not_listed: { tone: 'bad', icon: 'alert', head: 'Not on the supplier’s website' },
    stale: { tone: 'warn', icon: 'clock', head: 'The website check is over a day old' },
    unavailable: { tone: 'warn', icon: 'globe', head: 'The website could not be checked' },
    checking: { tone: 'warn', icon: 'radar', head: 'Checking the supplier’s website…' },
  };
  const t = tone[proof.status] ?? { tone: 'warn', icon: 'globe', head: 'Website check' };
  return (
    <div className={`note ${t.tone}`} role={proof.status === 'checking' ? 'status' : undefined}>
      <Icon name={t.icon} />
      <span style={{ display: 'grid', gap: 4 }}>
        <strong>
          {t.head}
          {proof.site ? ` · ${proof.site}` : ''}
        </strong>
        <span>{proof.text}</span>
        {proof.status === 'unavailable' && (
          <span>Confirm the address with the supplier yourself, on a number you already have.</span>
        )}
        {proof.txHash && (
          <a href={explorer(proof.txHash)} target="_blank" rel="noreferrer">
            The proof on Monad
          </a>
        )}
      </span>
    </div>
  );
}

export const shortId = (id: string) => id.slice(2, 10).toUpperCase();
export const explorer = (hash: string) => `https://testnet.monadexplorer.com/tx/${hash}`;
