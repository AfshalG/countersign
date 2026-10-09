import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { supplierId } from '@countersign/shared';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import {
  fileUrlOf,
  proofHashOf,
  WebsiteProofs,
  type ProofRecorder,
  type Prover,
} from '../../src/proofs/website.js';
import type { SolidityAttestation } from '../../src/proofs/attestation.js';
import { freshDatabase, truncate } from '../db/helpers.js';

/**
 * Slice 15: what a supplier's own website lists, proven by Primus and recorded on Monad. The
 * prover's answers are Spike 2's real proofs (7 Oct): the demo supplier's file listing its
 * address, and the same file changed to another address.
 */
let database: Database;
let store: Store;

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});

const SITE = 'https://countersign-supplier-demo.vercel.app';
const FILE = `${SITE}/.well-known/countersign.json`;
const KALIBRE: Address = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
const CHANGED: Address = '0xc91f6a35D139E713eAF11D72C8b76B609fA11385';
const ACCOUNT: Address = '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9';
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/attestation-${name}.json`, import.meta.url), 'utf8'));
const REAL = fixture('supplier');
const REAL_CHANGED = fixture('changed');
const SIGNED_AT = new Date(1_791_332_840_000);

class FakeProver implements Prover {
  calls: string[] = [];
  answer: () => Promise<unknown> = () => Promise.resolve(REAL);
  prove(url: string) {
    this.calls.push(url);
    return this.answer();
  }
}
class FakeRecorder implements ProofRecorder {
  recorded: SolidityAttestation[] = [];
  fail = false;
  record(att: SolidityAttestation) {
    if (this.fail) return Promise.reject(new Error('the relayer pool is empty'));
    this.recorded.push(att);
    const tx: Hex = `0x${'ab'.repeat(32)}`;
    return Promise.resolve(tx);
  }
}

let prover: FakeProver;
let recorder: FakeRecorder;
let files: Record<string, { status: number; body: string }>;
let clock: number;
const proofsWith = (over: Partial<ConstructorParameters<typeof WebsiteProofs>[0]> = {}) =>
  new WebsiteProofs({
    store,
    prover,
    recorder,
    fetch: (url) => {
      const f = files[url instanceof Request ? url.url : url.toString()];
      return Promise.resolve(new Response(f?.body ?? 'not found', { status: f?.status ?? 404 }));
    },
    now: () => clock,
    onFile: () => Promise.resolve(false),
    ...over,
  });

beforeEach(async () => {
  await truncate(database);
  prover = new FakeProver();
  recorder = new FakeRecorder();
  files = { [FILE]: { status: 200, body: `{ "payTo": "${KALIBRE}" }` } };
  clock = SIGNED_AT.getTime() + 60_000;
});

describe('the file a website publishes', () => {
  it('is /.well-known/countersign.json on the site’s own host, over HTTPS only', () => {
    expect(fileUrlOf('https://countersign-supplier-demo.vercel.app')).toBe(FILE);
    expect(fileUrlOf('https://Countersign-Supplier-Demo.vercel.app/about?x=1#y')).toBe(FILE);
    expect(fileUrlOf('http://countersign-supplier-demo.vercel.app')).toBeNull();
    expect(fileUrlOf('https://user:pw@kalibre.example')).toBeNull();
    expect(fileUrlOf('https://kalibre.example:8443')).toBeNull();
    expect(fileUrlOf('not a url')).toBeNull();
  });

  it('gives the registry’s proof hash: the URL, what it lists, and when Primus signed it', () => {
    expect(proofHashOf(FILE, KALIBRE, 1_791_332_840)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint64' }],
          [keccak256(stringToHex(FILE)), KALIBRE, 1_791_332_840n],
        ),
      ),
    );
  });
});

describe('checking a website', () => {
  it('proves what the file lists and records it on Monad', async () => {
    const row = await proofsWith().check(FILE);
    expect(prover.calls).toEqual([FILE]);
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.data).toBe(`{"payTo":"${KALIBRE}"}`);
    expect(row).toMatchObject({
      url: FILE,
      listed: KALIBRE,
      signedAt: SIGNED_AT,
      proofHash: proofHashOf(FILE, KALIBRE, 1_791_332_840),
      txHash: `0x${'ab'.repeat(32)}`,
      error: null,
    });
  });

  it('proves a file that lists another address just the same', async () => {
    prover.answer = () => Promise.resolve(REAL_CHANGED);
    const row = await proofsWith().check(FILE);
    expect(row.listed).toBe(CHANGED);
    expect(row.proofHash).not.toBeNull();
  });

  it('asks Primus once per file in 10 minutes, however many ask at once', async () => {
    const proofs = proofsWith();
    const [a, b] = await Promise.all([proofs.check(FILE), proofs.check(FILE)]);
    expect(a.id).toBe(b.id);
    expect((await proofs.check(FILE)).id).toBe(a.id);
    expect(prover.calls).toHaveLength(1);
    clock += 10 * 60_000 + 1;
    await proofs.check(FILE);
    expect(prover.calls).toHaveLength(2);
  });

  it('does not spend a proof on a site with no file, or a file that lists no address', async () => {
    files = {};
    expect((await proofsWith().check(FILE)).error).toBe('no_file');
    files = { [FILE]: { status: 200, body: '{"wallet":"0x12"}' } };
    clock += 61_000; // a failure is kept for a minute
    expect((await proofsWith().check(FILE)).error).toBe('bad_file');
    expect(prover.calls).toEqual([]);
  });

  it('says so when this gateway has no Primus keys', async () => {
    const row = await proofsWith({ prover: undefined }).check(FILE);
    expect(row).toMatchObject({ error: 'not_configured', listed: KALIBRE, proofHash: null });
  });

  it('says so when Primus fails or the registry does not record it, and tries again a minute later', async () => {
    prover.answer = () => Promise.reject(new Error('attestation failed: -1200010'));
    const proofs = proofsWith();
    expect((await proofs.check(FILE)).error).toBe('primus_failed');
    expect((await proofs.check(FILE)).error).toBe('primus_failed');
    expect(prover.calls).toHaveLength(1);

    clock += 61_000;
    prover.answer = () => Promise.resolve(REAL);
    recorder.fail = true;
    const row = await proofs.check(FILE);
    expect(row).toMatchObject({ error: 'record_failed', listed: KALIBRE, proofHash: null });
  });

  it('refuses a proof of another URL than the one asked', async () => {
    const other = structuredClone(REAL) as { request: { url: string } };
    other.request.url = 'https://evil.example/.well-known/countersign.json';
    prover.answer = () => Promise.resolve(other);
    expect((await proofsWith().check(FILE)).error).toBe('primus_failed');
    expect(recorder.recorded).toHaveLength(0);
  });
});

describe('checking a proposal (S15-4: which website)', () => {
  const proposal = async (over: { website?: string | null; supplierName?: string } = {}) => {
    const { proposal: p } = await store.createProposal({
      id: keccak256(stringToHex(`proposal ${String(Math.random())}`)),
      account: ACCOUNT,
      supplierName: over.supplierName ?? 'Kalibre Studio',
      website: over.website === undefined ? SITE : over.website,
      payTo: KALIBRE,
      amount: '5000',
      expiry: 1_800_000_000,
      documentHash: keccak256(stringToHex('quote')),
      document: null,
    });
    return p;
  };

  it('a new supplier is checked at the website its proposal gives', async () => {
    const p = await proposal();
    await proofsWith().checkProposal(p);
    const after = await store.getProposal(p.id);
    expect(after).toMatchObject({ proofStatus: 'done', proofUrl: FILE, proofSource: 'proposal' });
    expect(after?.proofId).not.toBeNull();
  });

  it('a supplier on file is checked at the website on file, not the proposal’s', async () => {
    const id = supplierId('kalibre-studio');
    await store.setSupplierWebsite(ACCOUNT, id, FILE);
    const p = await proposal({ website: 'https://kalibre-payments.example' });
    await proofsWith({ onFile: () => Promise.resolve(true) }).checkProposal(p);
    const after = await store.getProposal(p.id);
    expect(after).toMatchObject({ proofUrl: FILE, proofSource: 'on_file' });
    expect(prover.calls).toEqual([FILE]);
  });

  it('a supplier on file with no website recorded falls back to the proposal’s, and says so', async () => {
    const p = await proposal({ supplierName: 'Northwind Prints' });
    await proofsWith({ onFile: () => Promise.resolve(true) }).checkProposal(p);
    expect((await store.getProposal(p.id))?.proofSource).toBe('proposal');
  });

  it('the demo supplier on file is checked at its own site, whatever the proposal says', async () => {
    const p = await proposal({ website: 'https://kalibre-payments.example' });
    await proofsWith({ onFile: () => Promise.resolve(true) }).checkProposal(p);
    expect(await store.getProposal(p.id)).toMatchObject({ proofUrl: FILE, proofSource: 'on_file' });
  });

  it('no website to check is recorded as such', async () => {
    const p = await proposal({ website: null });
    await proofsWith().checkProposal(p);
    expect(await store.getProposal(p.id)).toMatchObject({
      proofStatus: 'done',
      proofError: 'no_website',
      proofId: null,
    });
  });

  it('a check that takes too long ends as a timeout, and a late result changes nothing', async () => {
    let release: (v: unknown) => void = () => undefined;
    prover.answer = () => new Promise((r) => (release = r));
    const p = await proposal();
    await proofsWith({ proposalTimeoutMs: 20 }).checkProposal(p);
    expect((await store.getProposal(p.id))?.proofError).toBe('timeout');
    release(REAL);
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.getProposal(p.id))?.proofId).toBeNull();
  });
});
