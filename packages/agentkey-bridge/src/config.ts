import { AgentkeyClient } from '@agentkey/sdk';
import { parseBindings, type AgentkeyBindings } from './bindings.js';

/**
 * Optional Agentkey verify gate for Countersign payment paths.
 * Off by default so existing testnet demos keep working.
 *
 * Env:
 * - AGENTKEY_VERIFY_ENABLED=true|1|yes
 * - AGENTKEY_BASE_URL=https://… (required when enabled)
 * - AGENTKEY_BINDINGS={"2066":"ak_…"} (ERC-8004 id → Agentkey id)
 * - AGENTKEY_ACCESS_TOKEN=… (optional bearer for private resolve; not required for verify)
 */

export type AgentkeyGateConfig = {
  enabled: boolean;
  baseUrl?: string;
  bindings: AgentkeyBindings;
  accessToken?: string;
};

export function isAgentkeyVerifyEnabled(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const v = source.AGENTKEY_VERIFY_ENABLED?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function loadAgentkeyGateConfig(
  source: Record<string, string | undefined> = process.env,
): AgentkeyGateConfig {
  const enabled = isAgentkeyVerifyEnabled(source);
  const baseUrl = source.AGENTKEY_BASE_URL?.trim().replace(/\/$/, '');
  const accessToken = source.AGENTKEY_ACCESS_TOKEN?.trim();
  const bindings = parseBindings(source.AGENTKEY_BINDINGS);

  if (enabled && !baseUrl) {
    throw new Error('AGENTKEY_VERIFY_ENABLED requires AGENTKEY_BASE_URL');
  }

  return {
    enabled,
    ...(baseUrl ? { baseUrl } : {}),
    bindings,
    ...(accessToken ? { accessToken } : {}),
  };
}

export function createAgentkeyClient(config: AgentkeyGateConfig): AgentkeyClient | undefined {
  if (!config.enabled || !config.baseUrl) return undefined;
  return new AgentkeyClient({
    baseUrl: config.baseUrl,
    ...(config.accessToken ? { accessToken: config.accessToken } : {}),
  });
}
