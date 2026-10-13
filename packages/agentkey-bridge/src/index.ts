/**
 * Thin Agentkey → Countersign bridge.
 *
 * Agentkey answers "who is this agent?". Countersign answers "may this agent pay?".
 * When `AGENTKEY_VERIFY_ENABLED` is on, the gateway calls Agentkey verify (fail closed)
 * before accepting a payment from a mapped ERC-8004 agent.
 */

export {
  assertAuthorizedToPay,
  isAuthorized,
  type AgentkeyVerifier,
  type AuthorizeDenied,
  type AuthorizeInput,
  type AuthorizeOk,
  type AuthorizeOutcome,
} from './authorize.js';

export { parseBindings, resolveAgentkeyId, type AgentkeyBindings } from './bindings.js';

export {
  createAgentkeyClient,
  isAgentkeyVerifyEnabled,
  loadAgentkeyGateConfig,
  type AgentkeyGateConfig,
} from './config.js';

export {
  AgentkeyClient,
  agentKeys,
  failClosed,
  type AgentId,
  type VerifyRequest,
  type VerifyResult,
  type VerifyStatus,
} from '@agentkey/sdk';
