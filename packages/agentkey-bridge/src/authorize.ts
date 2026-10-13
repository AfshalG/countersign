import { AgentkeyClient, type VerifyResult, type VerifyStatus } from '@agentkey/sdk';

/**
 * Agentkey = who. Countersign = may this agent pay.
 *
 * Before treating an agent as authorized to pay, call Agentkey `verify`.
 * Only `status: "valid"` authorizes. Transport / parse / crypto failures and
 * every other status fail closed — never soft-allow on error.
 */

export type AuthorizeInput = {
  /** Agentkey agent id (ak_…). */
  agentkeyId: string;
  /** JSON ownership proof for Agentkey verify. */
  proof: string;
  /** Optional context forwarded to Agentkey (e.g. payment id / challenge). */
  context?: Record<string, unknown>;
};

export type AuthorizeOk = { ok: true; result: VerifyResult };
export type AuthorizeDenied = {
  ok: false;
  status: VerifyStatus;
  reason: string;
  result: VerifyResult;
};

export type AuthorizeOutcome = AuthorizeOk | AuthorizeDenied;

export type AgentkeyVerifier = Pick<AgentkeyClient, 'verify'>;

/**
 * Call Agentkey verify and authorize only on `valid`.
 * Fail closed on every other outcome, including transport `error`.
 */
export async function assertAuthorizedToPay(
  client: AgentkeyVerifier,
  input: AuthorizeInput,
): Promise<AuthorizeOutcome> {
  if (!input.agentkeyId.trim()) {
    return denied('error', 'missing agentkey id', {
      status: 'error',
      reason: 'missing agentkey id',
    });
  }
  if (!input.proof.trim()) {
    return denied('error', 'missing agentkey proof', {
      status: 'error',
      reason: 'missing agentkey proof',
    });
  }

  let result: VerifyResult;
  try {
    result = await client.verify({
      agentId: input.agentkeyId,
      proof: input.proof,
      ...(input.context === undefined ? {} : { context: input.context }),
    });
  } catch (err) {
    // SDK already fail-closes transport into status:error; this is a last-resort belt.
    const reason = err instanceof Error ? err.message : 'verify threw';
    return denied('error', reason, { status: 'error', reason });
  }

  if (result.status === 'valid') {
    return { ok: true, result };
  }

  return denied(
    result.status,
    result.reason?.trim() || `agentkey verify status: ${result.status}`,
    result,
  );
}

function denied(status: VerifyStatus, reason: string, result: VerifyResult): AuthorizeDenied {
  return { ok: false, status, reason, result };
}

/** True only when Agentkey said `valid`. Anything else is a deny. */
export function isAuthorized(outcome: AuthorizeOutcome): outcome is AuthorizeOk {
  return outcome.ok;
}
