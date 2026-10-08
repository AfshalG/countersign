import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { TestChecker } from '../../src/checker.js';
import {
  connectChallenge,
  PER_HOUR,
  REPLIES,
  WhatsAppNotifier,
} from '../../src/notify/whatsapp.js';
import { OwnerActionError } from '../../src/owner/send.js';
import { SoftPasskey } from '../../scripts/passkey.js';
import { freshDatabase, truncate } from '../db/helpers.js';
import { FakeChain } from '../fakes.js';

const CHAIN_ID = 10143;
const ACCOUNT: Address = '0x4444444444444444444444444444444444444444';
const OTHER: Address = '0x6666666666666666666666666666666666666666';
const VAULT: Address = '0x7777777777777777777777777777777777777777';
const LOOK_ALIKE: Address = '0x90f9931F1721Ed8D9f47ea45B5E485e6182D5feC';
const PHONE = '447700900123';
const PHONE_2 = '447700900456';
const NUMBER = '15550783881';
const SECRET = 'meta-app-secret-0123456789';
const VERIFY = 'verify-token-0123456789';
const owner = SoftPasskey.fromScalar(`0x${'99'.repeat(32)}`);
const stranger = SoftPasskey.fromScalar(`0x${'aa'.repeat(32)}`);

let database: Database;
let store: Store;
let clock: Date;
let sent: { kind: 'link' | 'template' | 'text'; to: string; m: Record<string, string> }[];
let failSends: boolean;
let notifier: WhatsAppNotifier;
const template = { name: 'countersign_decision', language: 'en' };

function notifierWith(options: { template?: boolean } = {}) {
  let n = 0;
  const record =
    (kind: 'link' | 'template' | 'text') =>
    (to: string, m: Record<string, string> | string): Promise<string> => {
      if (failSends && kind !== 'text')
        return Promise.reject(new Error('(#131030) Recipient phone number not in allowed list'));
      sent.push({ kind, to, m: typeof m === 'string' ? { body: m } : m });
      n++;
      return Promise.resolve(`wamid.${String(n)}`);
    };
  return new WhatsAppNotifier({
    store,
    api: { link: record('link'), template: record('template'), text: record('text') },
    chain: {
      ownership: (a: Address) =>
        a.toLowerCase() === ACCOUNT.toLowerCase()
          ? Promise.resolve({ owners: [{ qx: owner.qx, qy: owner.qy }] })
          : Promise.reject(new Error('no such account')),
    },
    chainId: CHAIN_ID,
    publicUrl: 'https://gateway.test',
    number: NUMBER,
    ...(options.template === false ? {} : { template }),
    supplierName: () => Promise.resolve('Kalibre Studio'),
    now: () => clock,
    log: () => undefined,
  });
}

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  clock = new Date('2026-10-08T09:00:00Z');
  sent = [];
  failSends = false;
  notifier = notifierWith();
});

const browser = (passkey: SoftPasskey, digest: Hex) => {
  const a = passkey.sign(digest);
  return {
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    signature: { r: a.r, s: a.s },
  };
};
const minutes = (m: number) => {
  clock = new Date(clock.getTime() + m * 60_000);
};
/** What Meta posts when a person sends a text to the number. */
const textFrom = (from: string, body: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: NUMBER, phone_number_id: '106540352242922' },
            contacts: [{ profile: { name: 'Afshal' }, wa_id: from }],
            messages: [
              {
                from,
                id: `wamid.in.${body}`,
                timestamp: '1760000000',
                type: 'text',
                text: { body },
              },
            ],
          },
        },
      ],
    },
  ],
});
const statusOf = (id: string, status: string, error?: string) => ({
  entry: [
    {
      changes: [
        {
          value: {
            statuses: [
              {
                id,
                status,
                timestamp: '1760000000',
                recipient_id: PHONE,
                ...(error ? { errors: [{ code: 131026, title: error }] } : {}),
              },
            ],
          },
        },
      ],
    },
  ],
});

/** An owner gets a code, signs it, and the person sends it from WhatsApp. */
async function connect(from = PHONE) {
  const { code, challenge } = await notifier.issueCode(ACCOUNT);
  await notifier.signCode(code, browser(owner, challenge));
  await notifier.inbound(textFrom(from, `CONNECT ${code}`));
  return code;
}

let invoice = 0;
async function heldPayment(
  reason: 'address_mismatch' | 'hidden_instructions' = 'address_mismatch',
) {
  invoice++;
  const { request } = await store.createRequest({
    id: keccak256(toHex(`held ${String(invoice)}`)),
    account: ACCOUNT,
    vault: VAULT,
    invoiceHash: keccak256(toHex(`invoice ${String(invoice)}`)),
    payTo: LOOK_ALIKE,
    amount: 1_000n,
    deadline: 1_791_400_000,
    agentSig: `0x${'ab'.repeat(65)}`,
  });
  await store.transition(request.id, 'requested', 'checking');
  await store.transition(request.id, 'checking', 'held', { reason, decidedBy: 'rule' });
  return request.id;
}

describe('connecting WhatsApp to an account (an owner’s passkey, then the person’s message)', () => {
  it('connects the number that sends a code an owner signed, and says so', async () => {
    const { code, challenge, expiresAt } = await notifier.issueCode(ACCOUNT);
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(challenge).toBe(connectChallenge(CHAIN_ID, ACCOUNT, code));
    expect(new Date(expiresAt).getTime() - clock.getTime()).toBe(15 * 60_000);
    const signed = await notifier.signCode(code.toLowerCase(), browser(owner, challenge));
    expect(signed).toMatchObject({ number: NUMBER, text: `CONNECT ${code}` });
    expect(signed.link).toBe(`https://wa.me/${NUMBER}?text=CONNECT%20${code}`);

    await notifier.inbound(textFrom(PHONE, `  connect ${code.toLowerCase()} `));
    expect((await store.whatsappContacts(ACCOUNT)).map((c) => c.waId)).toEqual([PHONE]);
    expect(sent).toEqual([
      { kind: 'text', to: PHONE, m: { body: REPLIES.connected(ACCOUNT.toLowerCase()) } },
    ]);
  });

  it('refuses a stranger’s passkey and a passkey that signed another code', async () => {
    const { code, challenge } = await notifier.issueCode(ACCOUNT);
    await expect(notifier.signCode(code, browser(stranger, challenge))).rejects.toMatchObject({
      code: 'invalid_passkey',
      status: 422,
    });
    const other = await notifier.issueCode(ACCOUNT);
    await expect(notifier.signCode(code, browser(owner, other.challenge))).rejects.toMatchObject({
      code: 'challenge_mismatch',
    });
  });

  it('does not connect with a code no owner signed, one used already, or one expired', async () => {
    const unsigned = await notifier.issueCode(ACCOUNT);
    await notifier.inbound(textFrom(PHONE, `CONNECT ${unsigned.code}`));
    expect(await store.whatsappContacts(ACCOUNT)).toEqual([]);
    expect(sent.at(-1)?.m.body).toBe(REPLIES.badCode);

    const code = await connect(PHONE);
    await notifier.inbound(textFrom(PHONE_2, `CONNECT ${code}`));
    expect((await store.whatsappContacts(ACCOUNT)).map((c) => c.waId)).toEqual([PHONE]);
    expect(sent.at(-1)).toMatchObject({ to: PHONE_2, m: { body: REPLIES.badCode } });

    const late = await notifier.issueCode(ACCOUNT);
    await notifier.signCode(late.code, browser(owner, late.challenge));
    minutes(16);
    await notifier.inbound(textFrom(PHONE_2, `CONNECT ${late.code}`));
    expect(sent.at(-1)?.m.body).toBe(REPLIES.badCode);
    await expect(
      notifier.signCode(late.code, browser(owner, late.challenge)),
    ).rejects.toMatchObject({ code: 'code_expired' });
  });

  it('gives no code for an address that is not a Countersign account, and caps codes per hour', async () => {
    await expect(notifier.issueCode(OTHER)).rejects.toBeInstanceOf(OwnerActionError);
    for (let i = 0; i < 10; i++) await notifier.issueCode(ACCOUNT);
    await expect(notifier.issueCode(ACCOUNT)).rejects.toMatchObject({ code: 'too_many_codes' });
  });

  it('STOP disconnects the number; a second STOP says it is not connected', async () => {
    await connect();
    await notifier.inbound(textFrom(PHONE, 'stop'));
    expect(await store.whatsappContacts(ACCOUNT)).toEqual([]);
    expect(sent.at(-1)?.m.body).toBe(REPLIES.stopped);
    await notifier.inbound(textFrom(PHONE, 'STOP'));
    expect(sent.at(-1)?.m.body).toBe(REPLIES.notConnected);
  });
});

describe('a held payment on WhatsApp', () => {
  it('sends each connected person one link-button message to the approval page', async () => {
    await connect(PHONE);
    await connect(PHONE_2);
    sent = [];
    const id = await heldPayment();
    await notifier.held(id);
    await notifier.held(id); // the same hold again: nobody hears twice
    expect(sent.map((s) => [s.kind, s.to])).toEqual([
      ['link', PHONE],
      ['link', PHONE_2],
    ]);
    const m = sent[0]?.m;
    expect(m?.url).toBe(`https://gateway.test/p/${id}`);
    expect(m?.button).toBe('Review and decide');
    expect(m?.body).toContain('nothing was paid');
    expect(m?.body).toContain('0.001 USDC to Kalibre Studio');
    expect(m?.body).toContain(
      "The invoice's payment address is not the supplier's address on file.",
    );
    const rows = await store.whatsappMessages(id);
    expect(rows.map((r) => [r.status, r.via, r.messageId !== null])).toEqual([
      ['sent', 'link', true],
      ['sent', 'link', true],
    ]);
  });

  it('uses the approved template outside the 24-hour window, and skips without one', async () => {
    await connect();
    sent = [];
    minutes(25 * 60);
    const id = await heldPayment('hidden_instructions');
    await notifier.held(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'template', to: PHONE });
    expect(sent[0]?.m).toMatchObject({ name: template.name, language: 'en', urlSuffix: id });
    expect(sent[0]?.m.text).toBe(
      'a payment of 0.001 USDC to Kalibre Studio was held: The invoice contains instructions aimed at an automated reader, which a person reading it would not see or expect',
    );

    const without = notifierWith({ template: false });
    const second = await heldPayment();
    await without.held(second);
    expect(sent).toHaveLength(1);
    expect((await store.whatsappMessages(second))[0]).toMatchObject({
      status: 'skipped',
      error: 'outside_24h_no_template',
    });
  });

  it('a message from the person opens the window again', async () => {
    await connect();
    minutes(25 * 60);
    await notifier.inbound(textFrom(PHONE, 'hi'));
    expect(sent.at(-1)?.m.body).toBe(REPLIES.help);
    await notifier.held(await heldPayment());
    expect(sent.at(-1)?.kind).toBe('link');
  });

  it(`sends at most ${String(PER_HOUR)} an hour to one number: a big run does not flood the phone`, async () => {
    await connect();
    sent = [];
    const ids = [];
    for (let i = 0; i < PER_HOUR + 2; i++) ids.push(await heldPayment());
    for (const id of ids) await notifier.held(id);
    expect(sent).toHaveLength(PER_HOUR);
    expect((await store.whatsappMessages(ids.at(-1) ?? ''))[0]).toMatchObject({
      status: 'skipped',
      error: 'rate_limited',
    });
    minutes(61);
    await notifier.held(await heldPayment());
    expect(sent).toHaveLength(PER_HOUR + 1);
  });

  it('records a send WhatsApp refused, and carries on', async () => {
    await connect();
    failSends = true;
    const id = await heldPayment();
    await expect(notifier.held(id)).resolves.toBeUndefined();
    expect((await store.whatsappMessages(id))[0]).toMatchObject({
      status: 'failed',
      error: '(#131030) Recipient phone number not in allowed list',
    });
  });

  it('sends nothing for a payment that is not held, or with nobody connected', async () => {
    const id = await heldPayment();
    await notifier.held(id);
    expect(sent).toEqual([]);
    await connect();
    sent = [];
    await notifier.held(keccak256(toHex('no such payment')));
    expect(sent).toEqual([]);
  });

  it('follows delivery statuses forward only, and records a failure', async () => {
    await connect();
    const id = await heldPayment();
    await notifier.held(id);
    const messageId = (await store.whatsappMessages(id))[0]?.messageId ?? '';
    await notifier.inbound(statusOf(messageId, 'delivered'));
    await notifier.inbound(statusOf(messageId, 'sent')); // late: ignored
    expect((await store.whatsappMessages(id))[0]?.status).toBe('delivered');
    await notifier.inbound(statusOf(messageId, 'read'));
    expect((await store.whatsappMessages(id))[0]?.status).toBe('read');

    const second = await heldPayment();
    await notifier.held(second);
    const id2 = (await store.whatsappMessages(second))[0]?.messageId ?? '';
    await notifier.inbound(statusOf(id2, 'failed', 'Message undeliverable'));
    expect((await store.whatsappMessages(second))[0]).toMatchObject({
      status: 'failed',
      error: 'Message undeliverable',
    });
  });
});

describe('a proposed supplier on WhatsApp', () => {
  it('the store announces a new proposal once, not the same quote proposed again', async () => {
    const heard: string[] = [];
    const stop = store.onProposal((p) => heard.push(p.supplierName));
    const proposal = {
      id: keccak256(toHex('once')),
      account: ACCOUNT,
      supplierName: 'Northwind Prints',
      website: null,
      payTo: LOOK_ALIKE,
      amount: '20000',
      expiry: 1_800_000_000,
      documentHash: keccak256(toHex('quote once')),
      document: null,
    };
    await store.createProposal(proposal);
    await store.createProposal(proposal);
    stop();
    expect(heard).toEqual(['Northwind Prints']);
  });

  it('sends the link to approve or refuse it', async () => {
    await connect();
    sent = [];
    const { proposal } = await store.createProposal({
      id: keccak256(toHex('proposal')),
      account: ACCOUNT,
      supplierName: 'Northwind Prints',
      website: null,
      payTo: LOOK_ALIKE,
      amount: '20000',
      expiry: 1_800_000_000,
      documentHash: keccak256(toHex('quote')),
      document: null,
    });
    await notifier.proposed(proposal);
    expect(sent[0]).toMatchObject({ kind: 'link', to: PHONE });
    expect(sent[0]?.m.body).toContain('An agent proposed Northwind Prints as a supplier');
    expect(sent[0]?.m.body).toContain('0.02 USDC');
    expect(sent[0]?.m.url).toBe(`https://gateway.test/p/${proposal.id}`);
  });
});

describe('the routes', () => {
  const sign = (body: string) =>
    `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
  const app = () =>
    createApp({
      store,
      chain: new FakeChain(),
      checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
      chainId: CHAIN_ID,
      checkerTimeoutMs: 2_000,
      token: 'test-service-token-0123456789',
      publicUrl: 'https://gateway.test',
      health: () => Promise.resolve({}),
      whatsapp: { notifier, verifyToken: VERIFY, appSecret: SECRET },
    });

  it('answers Meta’s verification with the challenge, only for our token', async () => {
    const a = app();
    const ok = await a.request(
      `/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('1158201444');
    const wrong = await a.request(
      '/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1',
    );
    expect(wrong.status).toBe(403);
  });

  it('acts only on webhook bodies Meta signed', async () => {
    const a = app();
    const { code, challenge } = await notifier.issueCode(ACCOUNT);
    await notifier.signCode(code, browser(owner, challenge));
    const body = JSON.stringify(textFrom(PHONE, `CONNECT ${code}`));
    const forged = await a.request('/v1/whatsapp/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(`${body} `) },
      body,
    });
    expect(forged.status).toBe(401);
    const unsigned = await a.request('/v1/whatsapp/webhook', { method: 'POST', body });
    expect(unsigned.status).toBe(401);
    expect(await store.whatsappContacts(ACCOUNT)).toEqual([]);
    const real = await a.request('/v1/whatsapp/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(real.status).toBe(200);
    expect((await store.whatsappContacts(ACCOUNT)).map((c) => c.waId)).toEqual([PHONE]);
  });

  it('issues and signs a code from the phone’s browser, with no service token', async () => {
    const a = app();
    const issued = await a.request('/v1/whatsapp/codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://approver.example' },
      body: JSON.stringify({ account: ACCOUNT }),
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get('access-control-allow-origin')).toBe('*');
    const { code, challenge } = (await issued.json()) as { code: string; challenge: Hex };
    const signed = await a.request(`/v1/whatsapp/codes/${code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: browser(owner, challenge) }),
    });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({
      link: `https://wa.me/${NUMBER}?text=CONNECT%20${code}`,
    });
    const stranger_ = await a.request(`/v1/whatsapp/codes/${code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: browser(stranger, challenge) }),
    });
    expect(stranger_.status).toBe(422);
    const unknown = await a.request('/v1/whatsapp/codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: OTHER }),
    });
    expect(unknown.status).toBe(404);
  });

  it('has no WhatsApp routes when WhatsApp is not configured', async () => {
    const a = createApp({
      store,
      chain: new FakeChain(),
      checker: new TestChecker(generatePrivateKey(), CHAIN_ID),
      chainId: CHAIN_ID,
      checkerTimeoutMs: 2_000,
      token: 'test-service-token-0123456789',
      publicUrl: 'https://gateway.test',
      health: () => Promise.resolve({}),
    });
    const res = await a.request('/v1/whatsapp/webhook?hub.mode=subscribe');
    expect(res.status).toBe(404);
  });
});
