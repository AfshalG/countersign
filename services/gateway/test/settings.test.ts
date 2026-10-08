import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { checkerMode, judgeMode, loadSettings, whatsappMode } from '../src/settings.js';

const base = {
  DATABASE_URL: 'postgres://localhost:5432/gateway',
  MONAD_CHAIN_ID: '10143',
  MONAD_WS_URL: 'wss://testnet-rpc.monad.xyz',
  RELAYER_PRIVATE_KEYS: generatePrivateKey(),
  GATEWAY_SERVICE_TOKEN: 'test-service-token-0123456789',
  TEST_CHECKER_PRIVATE_KEY: generatePrivateKey(),
  PUBLIC_URL: 'https://gateway.test',
  PORT: '8787',
};

describe('judge mode settings', () => {
  it('is off when neither key is set', () => {
    expect(judgeMode(loadSettings(base))).toBeUndefined();
  });

  it('is on with both keys, at 20 accounts a day unless set', () => {
    const funder = generatePrivateKey();
    const agent = generatePrivateKey();
    const on = judgeMode(
      loadSettings({ ...base, DEMO_FUNDER_PRIVATE_KEY: funder, DEMO_AGENT_PRIVATE_KEY: agent }),
    );
    expect(on).toEqual({
      funderKey: funder,
      agentKey: agent,
      agent: privateKeyToAddress(agent),
      perDay: 20,
    });
    const capped = judgeMode(
      loadSettings({
        ...base,
        DEMO_FUNDER_PRIVATE_KEY: funder,
        DEMO_AGENT_PRIVATE_KEY: agent,
        DEMO_ACCOUNTS_PER_DAY: '5',
      }),
    );
    expect(capped?.perDay).toBe(5);
  });

  it('refuses a half-configured judge mode instead of switching it off quietly', () => {
    expect(() =>
      judgeMode(loadSettings({ ...base, DEMO_FUNDER_PRIVATE_KEY: generatePrivateKey() })),
    ).toThrow(/both/);
  });
});

describe('checker settings (Slice 10)', () => {
  const remote = {
    CHECKER_URL: 'https://checker.internal',
    CHECKER_TOKEN: 'checker-token-0123456789abcdef',
    CHECKER_ADDRESS: '0x5D6f4563A23f60bc32B446a5303255C08B1fDCA0',
  };
  it('uses the checker service when it is configured, and no checker key at all', () => {
    const withoutKey: Partial<typeof base> = { ...base };
    delete withoutKey.TEST_CHECKER_PRIVATE_KEY;
    expect(checkerMode(loadSettings({ ...withoutKey, ...remote }))).toEqual({
      kind: 'remote',
      url: 'https://checker.internal',
      token: remote.CHECKER_TOKEN,
      address: remote.CHECKER_ADDRESS,
    });
  });
  it('keeps the stand-in when only its key is set', () => {
    expect(checkerMode(loadSettings(base))).toMatchObject({ kind: 'stand-in' });
  });
  it('refuses a half-configured checker, and no checker at all', () => {
    expect(() => checkerMode(loadSettings({ ...base, CHECKER_URL: remote.CHECKER_URL }))).toThrow(
      /CHECKER_URL, CHECKER_TOKEN and CHECKER_ADDRESS/,
    );
    const withoutKey: Partial<typeof base> = { ...base };
    delete withoutKey.TEST_CHECKER_PRIVATE_KEY;
    expect(() => checkerMode(loadSettings(withoutKey))).toThrow(/checker/);
  });
});

describe('WhatsApp settings (Slice 14)', () => {
  const whatsapp = {
    WHATSAPP_PHONE_NUMBER_ID: '106540352242922',
    WHATSAPP_ACCESS_TOKEN: 'EAAJB-test-access-token-0123',
    WHATSAPP_APP_SECRET: 'meta-app-secret-0123456789',
    WHATSAPP_VERIFY_TOKEN: 'verify-token-0123456789',
    WHATSAPP_NUMBER: '15550783881',
  };

  it('is off when none is set, and nothing is sent', () => {
    expect(whatsappMode(loadSettings(base))).toBeUndefined();
  });

  it('is on with the five, the template only when named (English unless set)', () => {
    expect(whatsappMode(loadSettings({ ...base, ...whatsapp }))).toEqual({
      phoneNumberId: whatsapp.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: whatsapp.WHATSAPP_ACCESS_TOKEN,
      appSecret: whatsapp.WHATSAPP_APP_SECRET,
      verifyToken: whatsapp.WHATSAPP_VERIFY_TOKEN,
      number: whatsapp.WHATSAPP_NUMBER,
    });
    expect(
      whatsappMode(
        loadSettings({ ...base, ...whatsapp, WHATSAPP_TEMPLATE: 'countersign_decision' }),
      )?.template,
    ).toEqual({ name: 'countersign_decision', language: 'en' });
  });

  it('refuses to start half-configured, or with a number written with a plus or spaces', () => {
    const missing: Partial<typeof whatsapp> = { ...whatsapp };
    delete missing.WHATSAPP_APP_SECRET;
    expect(() => whatsappMode(loadSettings({ ...base, ...missing }))).toThrow(/together, or none/);
    expect(() =>
      loadSettings({ ...base, ...whatsapp, WHATSAPP_NUMBER: '+1 555 078 3881' }),
    ).toThrow();
  });
});
