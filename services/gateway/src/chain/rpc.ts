import type { Hex } from 'viem';

export type RpcFailure = 'rate' | 'transport' | 'rpc';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly kind: RpcFailure,
    /** Revert data, when the node returned some (a contract's named error). */
    readonly data?: Hex,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * One JSON-RPC call with a time limit and no hidden retries: callers decide what to retry, and a
 * library's silent retries would hide rate limits (Spike 3).
 */
export async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = 5_000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new RpcError(`${method}: ${e instanceof Error ? e.message : String(e)}`, 'transport');
  }
  if (res.status === 429) throw new RpcError(`${method}: HTTP 429`, 'rate');
  if (!res.ok) throw new RpcError(`${method}: HTTP ${String(res.status)}`, 'transport');
  let body: { result?: T; error?: { message?: string; data?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new RpcError(`${method}: response was not JSON`, 'transport');
  }
  if (body.error) {
    const message = body.error.message ?? 'unknown error';
    const data =
      typeof body.error.data === 'string' && body.error.data.startsWith('0x')
        ? (body.error.data as Hex)
        : undefined;
    throw new RpcError(
      `${method}: ${message}`,
      /limit|too many/i.test(message) ? 'rate' : 'rpc',
      data,
    );
  }
  return body.result as T;
}
