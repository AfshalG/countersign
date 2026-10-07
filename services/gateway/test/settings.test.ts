import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { judgeMode, loadSettings } from '../src/settings.js';

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
