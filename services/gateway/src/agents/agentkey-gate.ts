import {
  assertAuthorizedToPay,
  resolveAgentkeyId,
  type AgentkeyBindings,
  type AgentkeyVerifier,
} from '@countersign/agentkey-bridge';
import type { AgentDirectory } from './identity.js';

/**
 * Optional Agentkey verify gate on the payment path.
 * When enabled, only agents that Agentkey verifies as `valid` may pay.
 * Fail closed on every non-valid outcome (including transport error).
 */

export type AgentkeyGate = {
  client: AgentkeyVerifier;
  bindings: AgentkeyBindings;
  agents?: AgentDirectory;
};

export type AgentkeyProofInput = {
  /** Optional explicit Agentkey id; otherwise looked up from ERC-8004 via bindings. */
  id?: string | undefined;
  /** JSON ownership proof for Agentkey `/v1/verify`. */
  proof: string;
};

export type GateDenial = {
  error: 'agentkey_verify_failed';
  status: string;
  reason: string;
  agentkeyId: string | null;
  erc8004AgentId: string | null;
};

/**
 * Authorize a payment signer through Agentkey. Returns a denial payload, or `null` when allowed.
 */
export async function authorizePaymentAgent(
  gate: AgentkeyGate,
  input: {
    agentAddress: string | null;
    agentkey?: AgentkeyProofInput;
  },
): Promise<GateDenial | null> {
  const erc8004AgentId = gate.agents?.byAddress(input.agentAddress)?.agentId ?? null;
  const agentkeyId = resolveAgentkeyId(gate.bindings, erc8004AgentId, input.agentkey?.id);

  if (!agentkeyId) {
    return {
      error: 'agentkey_verify_failed',
      status: 'error',
      reason:
        'no Agentkey binding for this ERC-8004 agent; set AGENTKEY_BINDINGS or pass agentkey.id',
      agentkeyId: null,
      erc8004AgentId,
    };
  }

  const proof = input.agentkey?.proof ?? '';
  const outcome = await assertAuthorizedToPay(gate.client, {
    agentkeyId,
    proof,
    context: {
      erc8004AgentId,
      agentAddress: input.agentAddress,
    },
  });

  if (outcome.ok) return null;

  return {
    error: 'agentkey_verify_failed',
    status: outcome.status,
    reason: outcome.reason,
    agentkeyId,
    erc8004AgentId,
  };
}
