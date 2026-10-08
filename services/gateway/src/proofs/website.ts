import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { supplierId, supplierSlug } from '@countersign/shared';
import type { ProofError, ProposalRow, WebsiteProofRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { listedIn, toSolidityAttestation, type SolidityAttestation } from './attestation.js';

/**
 * Slice 15: whether a supplier's own website lists a payment address. The supplier publishes
 * `{ "payTo": "0x…" }` at `https://<site>/.well-known/countersign.json` (S2-1); Primus proves what
 * the file says (proxy-TLS, from this server), and the SupplierProofs contract on Monad checks the
 * proof and records it. The owner's phone shows the result, and the supplier record the owner
 * signs names the proof. It adds information and can hold; it never releases anything (D27).
 */

/** Asks Primus to prove the file at `url`; the real one is ./primus.ts. */
export interface Prover {
  prove(url: string): Promise<unknown>;
}

/** Records a proof in the SupplierProofs registry on Monad; resolves to the final transaction. */
export interface ProofRecorder {
  record(attestation: SolidityAttestation): Promise<Hex>;
}

const FILE_PATH = '/.well-known/countersign.json';
/** A proof of the same file is reused this long (S15-6: Primus's quota is not published). */
const REUSE_MS = 10 * 60_000;
/** A failed check is kept this long before the next one tries again. */
const FAILURE_MS = 60_000;
/** A proposal's check ends by then; its approval waits for it (S15-5). */
const PROPOSAL_TIMEOUT_MS = 60_000;
/** Reading the file before spending a proof on it. */
const FETCH_TIMEOUT_MS = 5_000;

/** The site's address file, on the website's own host, over HTTPS only; null otherwise. */
export function fileUrlOf(website: string): string | null {
  let url: URL;
  try {
    url = new URL(website);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return `https://${url.hostname.toLowerCase()}${FILE_PATH}`;
}

/** The registry's record id: keccak256(abi.encode(keccak256(url), listed, signedAt)). */
export function proofHashOf(url: string, listed: Address, signedAtSeconds: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint64' }],
      [keccak256(stringToHex(url)), listed, BigInt(signedAtSeconds)],
    ),
  );
}

export type WebsiteProofDeps = {
  store: Pick<
    Store,
    | 'addWebsiteProof'
    | 'latestWebsiteProof'
    | 'startProposalCheck'
    | 'finishProposalCheck'
    | 'supplierWebsite'
  >;
  /** Absent without Primus keys: every check then says `not_configured` (the fallback). */
  prover: Prover | undefined;
  recorder: ProofRecorder;
  /** Whether the supplier is on file in the account (a changed address uses its site on file). */
  onFile: (account: Address, supplierId: Hex) => Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
  proposalTimeoutMs?: number;
};

/** The demo supplier's site, for accounts whose Kalibre Studio was set up without a proposal. */
export const KALIBRE_FILE = `https://countersign-supplier-demo.vercel.app${FILE_PATH}`;
const KNOWN_SITES: Record<string, string> = {
  [supplierId('kalibre-studio').toLowerCase()]: KALIBRE_FILE,
};

export class WebsiteProofs {
  private readonly inFlight = new Map<string, Promise<WebsiteProofRow>>();

  constructor(private readonly deps: WebsiteProofDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** What the file lists, proven and recorded, or why not; a recent check is reused. */
  async check(url: string): Promise<WebsiteProofRow> {
    const recent = await this.deps.store.latestWebsiteProof(url);
    if (recent) {
      const age = this.now() - recent.createdAt.getTime();
      if (age < (recent.error === null ? REUSE_MS : FAILURE_MS)) return recent;
    }
    const running = this.inFlight.get(url);
    if (running) return running;
    const work = this.prove(url).finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, work);
    return work;
  }

  private async prove(url: string): Promise<WebsiteProofRow> {
    const createdAt = new Date(this.now());
    const failed = (error: ProofError, listed: Address | null = null) =>
      this.deps.store.addWebsiteProof({ url, listed, error, createdAt });

    // Read the file first: a missing or malformed file costs nothing to find out.
    const onSite = await this.readFile(url);
    if (onSite === 'no_file' || onSite === 'bad_file') return failed(onSite);
    if (!this.deps.prover) return failed('not_configured', onSite);

    let attestation: SolidityAttestation;
    let listed: Address | null;
    try {
      attestation = toSolidityAttestation(await this.deps.prover.prove(url));
      listed = listedIn(attestation.data);
      // Only a proof of this very file, with one address in it, is worth recording.
      if (attestation.request.url !== url || listed === null) throw new Error('not this file');
    } catch (e) {
      console.error(`website proof ${url}: ${e instanceof Error ? e.message : String(e)}`);
      return failed('primus_failed', onSite);
    }
    const signedAt = Number(attestation.timestamp / 1000n);
    let txHash: Hex;
    try {
      txHash = await this.deps.recorder.record(attestation);
    } catch (e) {
      console.error(
        `website proof ${url} not recorded: ${e instanceof Error ? e.message : String(e)}`,
      );
      return failed('record_failed', listed);
    }
    return this.deps.store.addWebsiteProof({
      url,
      listed,
      signedAt: new Date(signedAt * 1000),
      proofHash: proofHashOf(url, listed, signedAt),
      txHash,
      createdAt,
    });
  }

  private async readFile(url: string): Promise<Address | 'no_file' | 'bad_file'> {
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error', // the proof is of this URL; a redirect is another file
      });
    } catch {
      return 'no_file';
    }
    if (res.status !== 200) return 'no_file';
    try {
      const body = (await res.json()) as { payTo?: unknown };
      return typeof body.payTo === 'string' && isAddress(body.payTo, { strict: false })
        ? getAddress(body.payTo)
        : 'bad_file';
    } catch {
      return 'bad_file';
    }
  }

  /**
   * The site a proposal is checked against (S15-4): for a supplier already on file, the website
   * it was approved with, never the one a new proposal gives (a hijacked agent can name its own).
   */
  async websiteFor(
    p: Pick<ProposalRow, 'account' | 'supplierName' | 'website'>,
  ): Promise<{ url: string; source: 'on_file' | 'proposal' } | null> {
    const account = p.account as Address;
    const id = supplierId(supplierSlug(p.supplierName));
    if (await this.deps.onFile(account, id)) {
      const onFile = await this.siteOnFile(account, id);
      if (onFile) return { url: onFile, source: 'on_file' };
    }
    const given = p.website === null ? null : fileUrlOf(p.website);
    return given ? { url: given, source: 'proposal' } : null;
  }

  /** The address file of the website a supplier was approved with, if it is known. */
  async siteOnFile(account: Address, supplier: Hex): Promise<string | null> {
    return (
      (await this.deps.store.supplierWebsite(account, supplier)) ??
      KNOWN_SITES[supplier.toLowerCase()] ??
      null
    );
  }

  /** Checks a new proposal's website; the approval waits for it, at most a minute. */
  async checkProposal(p: ProposalRow): Promise<void> {
    const site = await this.websiteFor(p);
    if (!site) {
      await this.deps.store.finishProposalCheck(p.id, { error: 'no_website', url: null });
      return;
    }
    await this.deps.store.startProposalCheck(p.id, site);
    const timeout = this.deps.proposalTimeoutMs ?? PROPOSAL_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      this.check(site.url).then(
        (row) => ({ row }),
        () => ({ error: 'primus_failed' as const }),
      ),
      new Promise<{ error: 'timeout' }>((resolve) => {
        timer = setTimeout(() => {
          resolve({ error: 'timeout' });
        }, timeout);
      }),
    ]);
    clearTimeout(timer);
    await this.deps.store.finishProposalCheck(
      p.id,
      'row' in outcome ? { proofId: outcome.row.id } : { error: outcome.error },
    );
  }
}
