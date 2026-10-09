'use client';
import { markDifferences } from '../lib/diff';

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

/** "1 of 2 signed" for an action that needs several owners (D36). */
export function Signed({
  signatures,
}: {
  signatures?: { need: number; signed: number[] } | undefined;
}) {
  if (!signatures || signatures.need <= 1) return null;
  return (
    <span className="pill">
      {signatures.signed.length} of {signatures.need} signed
    </span>
  );
}

export function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="note bad" role="alert">
      {text}
    </p>
  );
}

export const shortId = (id: string) => id.slice(2, 10).toUpperCase();
export const explorer = (hash: string) => `https://testnet.monadexplorer.com/tx/${hash}`;
