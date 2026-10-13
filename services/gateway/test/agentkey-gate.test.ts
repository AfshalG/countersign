import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { IDENTITY_REGISTRY_TESTNET } from '@countersign/shared';
import type { VerifyResult } from '@countersign/agentkey-bridge';
import { AgentDirectory, type IdentityChain } from '../src/agents/identity.js';
import { authorizePaymentAgent } from '../src/agents/agentkey-gate.js';

const WALLET = getAddress('0x0f92A10b64B4A177cB1E090edC317C4202f71DC3');

async function directoryWith(wallet: Address, agentId = 2066n): Promise<AgentDirectory> {
  const identity: IdentityChain = {
    agentWallet: (id) =>
      id === agentId ? Promise.resolve(wallet) : Promise.reject(new Error('missing')),
  };
  const dir = new AgentDirectory(identity, IDENTITY_REGISTRY_TESTNET, 10143);
  const added = await dir.add(
    {
      upsertAgent: async (row) => ({
        agentId: row.agentId,
        registry: row.registry,
        wallet: row.wallet,
        addedAt: new Date(),
      }),
    },
    agentId,
  );
  expect(added?.wallet).toBe(wallet);
  return dir;
}

function client(result: VerifyResult) {
  return {
    verify: async (): Promise<VerifyResult> => result,
  };
}

describe('authorizePaymentAgent (gateway choke point)', () => {
  it('allows only when Agentkey returns valid', async () => {
    const denial = await authorizePaymentAgent(
      {
        client: client({ status: 'valid' }),
        bindings: new Map([['2066', 'ak_hosted']]),
        agents: await directoryWith(WALLET),
      },
      {
        agentAddress: WALLET,
        agentkey: { proof: '{"challenge":"c","signature":"ab"}' },
      },
    );
    expect(denial).toBeNull();
  });

  it('fail-closed: transport error denies payment (never soft-allows)', async () => {
    const denial = await authorizePaymentAgent(
      {
        client: client({ status: 'error', reason: 'fetch failed' }),
        bindings: new Map([['2066', 'ak_hosted']]),
        agents: await directoryWith(WALLET),
      },
      {
        agentAddress: WALLET,
        agentkey: { proof: '{}' },
      },
    );
    expect(denial).toEqual({
      error: 'agentkey_verify_failed',
      status: 'error',
      reason: 'fetch failed',
      agentkeyId: 'ak_hosted',
      erc8004AgentId: '2066',
    });
  });

  it('fail-closed: invalid proof denies', async () => {
    const denial = await authorizePaymentAgent(
      {
        client: client({ status: 'invalid', reason: 'bad signature' }),
        bindings: new Map([['2066', 'ak_hosted']]),
        agents: await directoryWith(WALLET),
      },
      { agentAddress: WALLET, agentkey: { proof: '{}' } },
    );
    expect(denial?.status).toBe('invalid');
    expect(denial?.error).toBe('agentkey_verify_failed');
  });

  it('denies when there is no binding and no explicit id', async () => {
    const denial = await authorizePaymentAgent(
      {
        client: client({ status: 'valid' }),
        bindings: new Map(),
        agents: await directoryWith(WALLET),
      },
      { agentAddress: WALLET, agentkey: { proof: '{}' } },
    );
    expect(denial?.status).toBe('error');
    expect(denial?.reason).toMatch(/no Agentkey binding/);
  });

  it('uses explicit agentkey.id when bindings are empty', async () => {
    const denial = await authorizePaymentAgent(
      {
        client: client({ status: 'valid' }),
        bindings: new Map(),
      },
      {
        agentAddress: WALLET,
        agentkey: { id: 'ak_explicit', proof: '{}' },
      },
    );
    expect(denial).toBeNull();
  });
});
