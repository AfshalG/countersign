import { zeroHash, type Hex } from 'viem';
import type { ProofError, WebsiteProofRow } from '../db/schema.js';

/**
 * What the owner's phone shows about a supplier's website (Slice 15, D35's states). "Listed on
 * the supplier's website", never "safe" (S2-3); stale evidence is shown as stale, never as
 * verified (D21).
 */
export type WebsiteProofStatus = 'checking' | 'verified' | 'not_listed' | 'stale' | 'unavailable';

export type WebsiteProofView = {
  /** The file checked: https://<site>/.well-known/countersign.json */
  url: string | null;
  /** Its host: what the owner should recognise as the supplier's own site. */
  site: string | null;
  /** The site on file for this supplier, or the one the proposal gave (S15-4). */
  source: 'on_file' | 'proposal' | null;
  status: WebsiteProofStatus;
  /** The address the file lists (proven when `proofHash` is set). */
  listed: string | null;
  /** When Primus signed the proof. */
  checkedAt: string | null;
  /** The record in the SupplierProofs registry on Monad, and the transaction that made it. */
  proofHash: string | null;
  txHash: string | null;
  reason: ProofError | null;
  text: string;
};

/** Older than this, a proof is shown as stale (S15-3, S2-4). */
export const STALE_MS = 24 * 3_600_000;
/** A check still running after this has ended as a timeout (S15-5). */
export const CHECK_MS = 60_000;

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

const hostOf = (url: string | null) => {
  if (url === null) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** A proof that shows the website listing `payTo`: the one a supplier record may name. */
export function bindingProof(proof: WebsiteProofRow | undefined, payTo: string): Hex {
  return proof?.proofHash &&
    proof.error === null &&
    proof.listed?.toLowerCase() === payTo.toLowerCase()
    ? (proof.proofHash as Hex)
    : zeroHash;
}

export function websiteProofView(input: {
  url: string | null;
  source: 'on_file' | 'proposal' | null;
  /** Null for proposals made before Slice 15: nothing was checked. */
  state: 'checking' | 'done' | null;
  error: ProofError | null;
  proof: WebsiteProofRow | undefined;
  payTo: string;
  startedAt: Date;
  now: number;
}): WebsiteProofView | null {
  if (input.state === null) return null;
  const site = hostOf(input.url);
  const base = {
    url: input.url,
    site,
    source: input.source,
    listed: input.proof?.listed ?? null,
    checkedAt: input.proof?.signedAt?.toISOString() ?? null,
    proofHash: input.proof?.proofHash ?? null,
    txHash: input.proof?.txHash ?? null,
  };
  const unavailable = (reason: ProofError): WebsiteProofView => {
    const where = site ?? 'the supplier’s website';
    const text =
      reason === 'no_website'
        ? 'No website to check: confirm the address with the supplier yourself.'
        : reason === 'no_file'
          ? `${where} does not publish a payment address (/.well-known/countersign.json): confirm it with the supplier yourself.`
          : reason === 'bad_file'
            ? `${where}'s address file does not list one address: confirm it with the supplier yourself.`
            : `Could not prove what ${where} lists right now: confirm the address with the supplier yourself.`;
    return { ...base, proofHash: null, txHash: null, status: 'unavailable', reason, text };
  };

  if (input.state === 'checking')
    return input.now - input.startedAt.getTime() < CHECK_MS
      ? {
          ...base,
          status: 'checking',
          reason: null,
          text: `Checking what ${site ?? 'the website'} lists…`,
        }
      : unavailable('timeout');
  if (input.error !== null) return unavailable(input.error);
  if (!input.proof) return unavailable('timeout');
  if (input.proof.error !== null) return unavailable(input.proof.error);

  const listed = input.proof.listed ?? '';
  const age = input.now - (input.proof.signedAt?.getTime() ?? 0);
  if (listed.toLowerCase() !== input.payTo.toLowerCase())
    return {
      ...base,
      status: 'not_listed',
      reason: null,
      text: `${site ?? 'The website'} lists a different address: ${listed} (proven ${ago(age)}).`,
    };
  return age > STALE_MS
    ? {
        ...base,
        status: 'stale',
        reason: null,
        text: `${site ?? 'The website'} listed this address ${ago(age)}; it has not been checked since.`,
      }
    : {
        ...base,
        status: 'verified',
        reason: null,
        text: `${site ?? 'The website'} lists this address (proven by Primus and recorded on Monad, ${ago(age)}).`,
      };
}

/**
 * A changed-address hold (Slice 15 part 2): what the supplier's website on file lists, against the
 * address on file and the invoice's. `status` is about the address on file (`verified`: the site
 * still lists it); `matches` says which of the two the site lists.
 */
export function holdWebsiteView(input: {
  url: string | null;
  proof: WebsiteProofRow | undefined;
  onFile: string;
  invoice: string;
  now: number;
}): (WebsiteProofView & { matches: 'on_file' | 'invoice' | 'neither' | null }) | null {
  const view = websiteProofView({
    url: input.url,
    source: 'on_file',
    state: input.url === null ? 'done' : input.proof ? 'done' : 'checking',
    error: input.url === null ? 'no_website' : null,
    proof: input.proof,
    payTo: input.onFile,
    startedAt: new Date(input.now),
    now: input.now,
  });
  if (!view) return null;
  if (view.status === 'checking' || view.status === 'unavailable')
    return { ...view, matches: null };
  const listed = (view.listed ?? '').toLowerCase();
  const site = view.site ?? 'The supplier’s website';
  if (listed === input.onFile.toLowerCase())
    return {
      ...view,
      matches: 'on_file',
      text: `${site} still lists the address on file, ${input.onFile}, not the invoice's (${view.status === 'stale' ? 'checked over a day ago' : 'proven by Primus, recorded on Monad'}).`,
    };
  if (listed === input.invoice.toLowerCase())
    return {
      ...view,
      matches: 'invoice',
      text: `${site} now lists the invoice's address, ${input.invoice}. If the supplier really changed it, change it on file first (a proposal, with the waiting period); this payment can only be refused.`,
    };
  return {
    ...view,
    matches: 'neither',
    text: `${site} lists ${view.listed ?? 'another address'}: neither the address on file nor the invoice's.`,
  };
}
