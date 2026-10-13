import { describe, expect, it } from 'vitest';
import {
  assertAuthorizedToPay,
  isAuthorized,
  type AgentkeyVerifier,
  type AuthorizeOutcome,
} from '../src/authorize.js';
import { parseBindings, resolveAgentkeyId } from '../src/bindings.js';
import { isAgentkeyVerifyEnabled, loadAgentkeyGateConfig } from '../src/config.js';
import type { VerifyResult } from '@agentkey/sdk';

function stub(
  result: VerifyResult | (() => Promise<VerifyResult>) | (() => never),
): AgentkeyVerifier {
  return {
    verify: async () => {
      if (typeof result === 'function') return result();
      return result;
    },
  };
}

describe('assertAuthorizedToPay (fail closed)', () => {
  it('authorizes only when Agentkey returns valid', async () => {
    const outcome = await assertAuthorizedToPay(stub({ status: 'valid' }), {
      agentkeyId: 'ak_demo',
      proof: '{"challenge":"c","signature":"ab"}',
    });
    expect(isAuthorized(outcome)).toBe(true);
    expect(outcome.ok).toBe(true);
  });

  it('denies on invalid — never soft-allows', async () => {
    const outcome = await assertAuthorizedToPay(stub({ status: 'invalid', reason: 'bad sig' }), {
      agentkeyId: 'ak_demo',
      proof: '{}',
    });
    expectDenied(outcome, 'invalid', 'bad sig');
  });

  it('denies on unknown', async () => {
    const outcome = await assertAuthorizedToPay(stub({ status: 'unknown', reason: 'not found' }), {
      agentkeyId: 'ak_missing',
      proof: '{}',
    });
    expectDenied(outcome, 'unknown', 'not found');
  });

  it('denies on revoked', async () => {
    const outcome = await assertAuthorizedToPay(stub({ status: 'revoked', reason: 'revoked' }), {
      agentkeyId: 'ak_revoked',
      proof: '{}',
    });
    expectDenied(outcome, 'revoked', 'revoked');
  });

  it('denies on transport/error status (fail closed)', async () => {
    const outcome = await assertAuthorizedToPay(stub({ status: 'error', reason: 'ECONNREFUSED' }), {
      agentkeyId: 'ak_demo',
      proof: '{}',
    });
    expectDenied(outcome, 'error', 'ECONNREFUSED');
  });

  it('denies when verify throws (fail closed belt)', async () => {
    const outcome = await assertAuthorizedToPay(
      {
        verify: () => Promise.reject(new Error('network down')),
      },
      { agentkeyId: 'ak_demo', proof: '{}' },
    );
    expectDenied(outcome, 'error', 'network down');
  });

  it('denies when agentkey id is missing', async () => {
    const calls: unknown[] = [];
    const outcome = await assertAuthorizedToPay(
      {
        verify: (req) => {
          calls.push(req);
          return Promise.resolve({ status: 'valid' as const });
        },
      },
      { agentkeyId: '  ', proof: '{}' },
    );
    expect(calls).toHaveLength(0);
    expectDenied(outcome, 'error', 'missing agentkey id');
  });

  it('denies when proof is missing without calling verify', async () => {
    const calls: unknown[] = [];
    const outcome = await assertAuthorizedToPay(
      {
        verify: (req) => {
          calls.push(req);
          return Promise.resolve({ status: 'valid' as const });
        },
      },
      { agentkeyId: 'ak_demo', proof: '' },
    );
    expect(calls).toHaveLength(0);
    expectDenied(outcome, 'error', 'missing agentkey proof');
  });
});

describe('bindings', () => {
  it('parses ERC-8004 → Agentkey map', () => {
    const map = parseBindings('{"2066":"ak_hosted","2067":"ak_demo"}');
    expect(resolveAgentkeyId(map, '2066')).toBe('ak_hosted');
    expect(resolveAgentkeyId(map, '2067', 'ak_override')).toBe('ak_override');
    expect(resolveAgentkeyId(map, '9999')).toBeUndefined();
  });

  it('rejects malformed bindings', () => {
    expect(() => parseBindings('not-json')).toThrow(/JSON/);
    expect(() => parseBindings('[]')).toThrow(/object/);
    expect(() => parseBindings('{"2066":1}')).toThrow(/non-empty/);
  });
});

describe('loadAgentkeyGateConfig', () => {
  it('is off by default so demos keep working', () => {
    expect(isAgentkeyVerifyEnabled({})).toBe(false);
    expect(loadAgentkeyGateConfig({}).enabled).toBe(false);
  });

  it('requires base URL when enabled', () => {
    expect(() => loadAgentkeyGateConfig({ AGENTKEY_VERIFY_ENABLED: 'true' })).toThrow(
      /AGENTKEY_BASE_URL/,
    );
  });

  it('loads enabled config', () => {
    const cfg = loadAgentkeyGateConfig({
      AGENTKEY_VERIFY_ENABLED: '1',
      AGENTKEY_BASE_URL: 'http://127.0.0.1:8787/',
      AGENTKEY_BINDINGS: '{"2066":"ak_x"}',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8787');
    expect(cfg.bindings.get('2066')).toBe('ak_x');
  });
});

function expectDenied(outcome: AuthorizeOutcome, status: string, reasonPart: string): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.status).toBe(status);
  expect(outcome.reason).toContain(reasonPart);
}
