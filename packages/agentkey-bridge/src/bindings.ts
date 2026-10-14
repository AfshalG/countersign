/**
 * Map Countersign / ERC-8004 agent ids → Agentkey agent ids.
 *
 * Env `AGENTKEY_BINDINGS` is a JSON object, e.g.
 *   {"2066":"ak_hosted_abc","2067":"ak_demo_xyz"}
 */

export type AgentkeyBindings = ReadonlyMap<string, string>;

export function parseBindings(raw: string | undefined): AgentkeyBindings {
  if (raw === undefined || raw.trim() === '') return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('AGENTKEY_BINDINGS must be JSON object of erc8004AgentId → agentkeyId');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AGENTKEY_BINDINGS must be a JSON object');
  }
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`AGENTKEY_BINDINGS[${k}] must be a non-empty Agentkey id string`);
    }
    map.set(k.trim(), v.trim());
  }
  return map;
}

/** Resolve Agentkey id from an ERC-8004 agent id, then an optional explicit override. */
export function resolveAgentkeyId(
  bindings: AgentkeyBindings,
  erc8004AgentId: string | null | undefined,
  explicit?: string | null,
): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  if (erc8004AgentId === undefined || erc8004AgentId === null || erc8004AgentId === '')
    return undefined;
  return bindings.get(erc8004AgentId);
}
