export type RpcFailure = 'rate' | 'transport' | 'rpc';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly kind: RpcFailure,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * One JSON-RPC call with a time limit and no hidden retries: the spike measures
 * rate limiting and retries itself, so a client library's automatic retries would
 * hide exactly what it is measuring.
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
  let body: { result?: T; error?: { message?: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new RpcError(`${method}: response was not JSON`, 'transport');
  }
  if (body.error) {
    const message = body.error.message ?? 'unknown error';
    throw new RpcError(`${method}: ${message}`, /limit|too many/i.test(message) ? 'rate' : 'rpc');
  }
  return body.result as T;
}
