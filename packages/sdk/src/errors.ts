/** One field the gateway refused, e.g. `{ path: 'payment.payTo', message: 'Invalid' }`. */
export type Issue = { path: string; message: string };

/**
 * Every failure the SDK reports. `code` is the gateway's typed error (`malformed`,
 * `unauthorized`, `unknown_request`, `not_held`, `invalid_passkey`, `chain_unavailable`, …) or
 * the SDK's own (`network`, `bad_response`, `unknown_order`, `no_agent_key`, `timeout`).
 */
export class CountersignError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly issues?: Issue[],
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CountersignError';
  }
}
