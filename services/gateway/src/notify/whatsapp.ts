import { randomInt } from 'node:crypto';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { formatUsdc, REASON_TEXT } from '@countersign/shared';
import { AssertionError, fromBrowser, type BrowserAssertion } from '../api/webauthn.js';
import type { WhatsappContactRow, ProposalRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { ownerSigOf } from '../owner/signers.js';
import { OwnerActionError } from '../owner/send.js';
import type { OwnerKey } from '../chain/types.js';
import type { WhatsAppApi } from './whatsapp-api.js';

/**
 * WhatsApp (Slice 14, D31): when a payment is held or an agent proposes a supplier, every person
 * connected to the account gets one message with a button that opens the approval page, whichever
 * agent prepared it. Deciding is still the passkey on that page; WhatsApp only carries the link.
 *
 * Connecting: an owner signs a one-off challenge with their passkey for a code, then sends
 * "CONNECT <code>" to Countersign's number. That message is the person's consent and opens
 * WhatsApp's 24-hour window, inside which a link-button message may be sent; outside it only an
 * approved template may. STOP disconnects.
 */

/** WhatsApp's customer-service window is 24 hours from the person's last message; ten minutes spare. */
export const WINDOW_MS = 24 * 3_600_000 - 10 * 60_000;
/** At most this many messages an hour to one number: a run of 200 invoices must not flood a phone. */
export const PER_HOUR = 10;
/** A connect code lasts this long, and an account gets at most this many an hour. */
export const CODE_MS = 15 * 60_000;
export const CODES_PER_HOUR = 10;

// No 0/O, 1/I/L: the code is read off a screen and typed on a phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newCode = () =>
  Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** What an owner's passkey signs to connect WhatsApp: fixed for this code, account and chain. */
export function connectChallenge(chainId: number, account: Address, code: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'address' }, { type: 'string' }, { type: 'uint256' }],
      ['Countersign: connect WhatsApp', account, code, BigInt(chainId)],
    ),
  );
}

export type WhatsAppDeps = {
  store: Store;
  api: Pick<WhatsAppApi, 'link' | 'template' | 'text'>;
  chain: { ownership(account: Address): Promise<{ owners: OwnerKey[] }> };
  chainId: number;
  /** Where approval pages are: `${publicUrl}/p/<id>`. */
  publicUrl: string;
  /** Countersign's WhatsApp number, digits with the country code (for the wa.me link). */
  number: string;
  /** The approved template for outside the 24-hour window; without it those messages are skipped. */
  template?: { name: string; language: string };
  supplierName?: (account: string, vault: string) => Promise<string | null>;
  now?: () => Date;
  log?: (line: string) => void;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usdc = (units: string) => formatUsdc(BigInt(units));
const sentence = (s: string) => s.replace(/\.$/, '');

export const REPLIES = {
  connected: (account: string) =>
    `Connected. Countersign will message you here when a payment from account ${short(account)} is held, or an agent proposes a supplier, with a link to decide with your passkey. Send STOP to disconnect.`,
  badCode:
    'That code is not valid: it may have expired or been used already. Get a new one from the approval page.',
  stopped: 'Disconnected. Countersign will not message you again unless you connect a new code.',
  notConnected: 'This number is not connected to a Countersign account.',
  help: 'This is Countersign. It messages you here when a payment is held or an agent proposes a supplier. To connect an account, get a code on its approval page and send it here. Send STOP to disconnect.',
};

type Inbound = {
  from?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
};
type Delivery = {
  id?: string;
  status?: string;
  errors?: { title?: string; message?: string }[];
};

export class WhatsAppNotifier {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: WhatsAppDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log =
      deps.log ??
      ((line) => {
        console.log(`whatsapp: ${line}`);
      });
  }

  // ---------- connecting ----------

  /** A code for an account, and the challenge an owner's passkey signs to make it usable. */
  async issueCode(account: Address) {
    try {
      await this.deps.chain.ownership(account);
    } catch {
      throw new OwnerActionError(404, 'unknown_account', 'no Countersign account at that address');
    }
    const now = this.now();
    const recent = await this.deps.store.whatsappLinksSince(
      account,
      new Date(now.getTime() - 3_600_000),
    );
    if (recent >= CODES_PER_HOUR)
      throw new OwnerActionError(
        429,
        'too_many_codes',
        'too many codes for this account; wait an hour',
      );
    const code = newCode();
    const expiresAt = new Date(now.getTime() + CODE_MS);
    await this.deps.store.createWhatsappLink(code, account, expiresAt, now);
    return {
      code,
      challenge: connectChallenge(this.deps.chainId, account, code),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** An owner signed for the code: it can now be sent from WhatsApp, once, before it expires. */
  async signCode(code: string, assertion: unknown) {
    const link = await this.deps.store.whatsappLink(code.toUpperCase());
    if (!link) throw new OwnerActionError(404, 'unknown_code', 'no such code');
    const now = this.now();
    if (link.usedAt !== null) throw new OwnerActionError(409, 'code_used', 'this code was used');
    if (link.expiresAt <= now) throw new OwnerActionError(409, 'code_expired', 'this code expired');
    const account = link.account as Address;
    let auth;
    try {
      auth = fromBrowser(
        assertion as BrowserAssertion,
        connectChallenge(this.deps.chainId, account, link.code),
      );
    } catch (e) {
      if (!(e instanceof AssertionError)) throw e;
      throw new OwnerActionError(e.code === 'challenge_mismatch' ? 422 : 400, e.code, e.message);
    }
    // Any one owner; checked even with a single owner, since nothing on chain checks it after.
    if (!(await ownerSigOf(this.deps.chain, account, auth, true)))
      throw new OwnerActionError(422, 'invalid_passkey', 'not this account’s passkey');
    if (link.signedAt === null) await this.deps.store.signWhatsappLink(link.code, now);
    const text = `CONNECT ${link.code}`;
    return {
      account,
      number: this.deps.number,
      text,
      link: `https://wa.me/${this.deps.number}?text=${encodeURIComponent(text)}`,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  // ---------- messages ----------

  /** A payment was held: each person connected to its account gets one message. */
  async held(requestId: string): Promise<void> {
    const row = await this.deps.store.get(requestId);
    if (!row || row.status !== 'held') return;
    const supplier =
      (await this.deps.supplierName?.(row.account, row.vault).catch(() => null)) ??
      short(row.payTo);
    const why = row.reason ? REASON_TEXT[row.reason] : 'It needs the owner.';
    await this.toEveryone(row.account, row.id, 'held', {
      header: 'Payment held',
      body: `Countersign held a payment; nothing was paid.\n\n${usdc(row.amount)} USDC to ${supplier}\nWhy: ${why}\n\nOpen it to pay it once or refuse it, with your passkey.`,
      summary: `a payment of ${usdc(row.amount)} USDC to ${supplier} was held: ${sentence(why)}`,
    });
  }

  /** An agent proposed a supplier and an order: each person connected to the account hears. */
  async proposed(p: ProposalRow): Promise<void> {
    if (p.status !== 'pending') return;
    await this.toEveryone(p.account, p.id, 'proposal', {
      header: 'New supplier proposed',
      body: `An agent proposed ${p.supplierName} as a supplier, with an order of ${usdc(p.amount)} USDC, paid only to ${short(p.payTo)}.\n\nNothing changes until you approve it with your passkey.`,
      summary: `an agent proposed ${p.supplierName} as a supplier, with an order of ${usdc(p.amount)} USDC`,
    });
  }

  private async toEveryone(
    account: string,
    subject: string,
    kind: 'held' | 'proposal',
    m: { header: string; body: string; summary: string },
  ) {
    const contacts = await this.deps.store.whatsappContacts(account);
    // One at a time: a handful of people, and each send is one HTTPS call.
    for (const contact of contacts) await this.deliver(contact, subject, kind, m);
  }

  private async deliver(
    contact: WhatsappContactRow,
    subject: string,
    kind: 'held' | 'proposal',
    m: { header: string; body: string; summary: string },
  ) {
    const { store } = this.deps;
    const { waId } = contact;
    const now = this.now();
    if (!(await store.claimWhatsappMessage({ subject, waId, account: contact.account, kind, now })))
      return; // this person already has (or is getting) the message about it
    // The claim counts itself, so more than PER_HOUR means this one is over.
    if ((await store.whatsappMessagesSince(waId, new Date(now.getTime() - 3_600_000))) > PER_HOUR)
      return store.finishWhatsappMessage(subject, waId, {
        status: 'skipped',
        error: 'rate_limited',
      });
    const inWindow = now.getTime() - contact.lastInboundAt.getTime() < WINDOW_MS;
    try {
      if (inWindow) {
        const messageId = await this.deps.api.link(waId, {
          header: m.header,
          body: m.body,
          button: 'Review and decide',
          url: `${this.deps.publicUrl}/p/${subject}`,
        });
        await store.finishWhatsappMessage(subject, waId, {
          status: 'sent',
          via: 'link',
          messageId,
        });
      } else if (this.deps.template) {
        const messageId = await this.deps.api.template(waId, {
          ...this.deps.template,
          text: m.summary,
          urlSuffix: subject,
        });
        await store.finishWhatsappMessage(subject, waId, {
          status: 'sent',
          via: 'template',
          messageId,
        });
      } else
        await store.finishWhatsappMessage(subject, waId, {
          status: 'skipped',
          error: 'outside_24h_no_template',
        });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log(`${kind} ${subject} to …${waId.slice(-4)} failed: ${error}`);
      await store.finishWhatsappMessage(subject, waId, { status: 'failed', error });
    }
  }

  // ---------- the webhook ----------

  /** A webhook body Meta signed: people's messages (CONNECT, STOP) and delivery statuses. */
  async inbound(payload: unknown): Promise<void> {
    const changes =
      (payload as { entry?: { changes?: { value?: unknown }[] }[] } | null)?.entry?.flatMap(
        (e) => e.changes ?? [],
      ) ?? [];
    for (const change of changes) {
      const value = change.value as { messages?: Inbound[]; statuses?: Delivery[] } | undefined;
      for (const s of value?.statuses ?? [])
        if (s.id && s.status) {
          const error = s.errors?.[0];
          await this.deps.store.whatsappDelivery(
            s.id,
            s.status,
            error ? (error.message ?? error.title) : undefined,
          );
        }
      for (const message of value?.messages ?? []) await this.message(message);
    }
  }

  private async message(m: Inbound) {
    const from = m.from;
    if (!from) return;
    const now = this.now();
    await this.deps.store.touchWhatsapp(from, now);
    const text = (m.type === 'text' ? m.text?.body : m.button?.text)?.trim();
    if (text === undefined) return; // a photo, a reaction, a location: nothing to answer
    const connect = /^connect\s+([a-z0-9]{8})$/i.exec(text);
    let reply: string;
    if (connect?.[1]) {
      const account = await this.deps.store.redeemWhatsappLink(connect[1].toUpperCase(), from, now);
      reply = account ? REPLIES.connected(account) : REPLIES.badCode;
      if (account) this.log(`…${from.slice(-4)} connected to ${account}`);
    } else if (/^(stop|unsubscribe)$/i.test(text)) {
      reply =
        (await this.deps.store.removeWhatsapp(from)) > 0 ? REPLIES.stopped : REPLIES.notConnected;
    } else reply = REPLIES.help;
    try {
      await this.deps.api.text(from, reply);
    } catch (e) {
      this.log(`reply to …${from.slice(-4)} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
