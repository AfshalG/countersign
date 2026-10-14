/**
 * The gateway, seen from the phone (Slice 11). The owner's routes (approvals, judge mode, the stop
 * button, approvers, bank accounts) need no token: the passkey is the authorisation, checked by the
 * account itself. Routes for the account's own data (its inbox, orders, records) take the account's
 * own token (`cs_…`), got with one Face ID signature; the gateway's service token never reaches
 * the browser.
 */
export const GATEWAY = (
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'https://gateway-production-e17a.up.railway.app'
).replace(/\/$/, '');

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

const WORDS: Record<string, string> = {
  invalid_passkey: 'That passkey is not an owner of this account.',
  challenge_mismatch:
    'What you signed has changed since it was shown. Open it again and sign the new version.',
  not_held: 'This payment was already decided.',
  not_pending: 'This proposal was already decided.',
  demo_limit: 'The demo has made all the accounts it can today. Try again tomorrow.',
  order_used_up: 'The demo order has nothing left to pay.',
  not_ready: 'The account is still being set up.',
  order_not_indexed: 'The new order is still being read from Monad. Try again in a few seconds.',
  malformed_assertion: 'The passkey answer could not be read. Try again.',
  unknown_request: 'There is no payment with that id.',
  unknown_approval: 'There is nothing to approve with that id.',
  unauthorized: 'This phone is not connected to the account yet.',
  wrong_account: 'This phone is connected to another account.',
  nothing_held: 'Nothing in this run is held for that reason any more.',
  invalid_bank: 'The bank details are not valid.',
  unknown_supplier: 'This account has no order with that supplier.',
  // 13 Oct: every other documented error a screen can meet (FEATURES 1, 2, 7, 8, 9, 11).
  stale: 'The account changed since this was opened. Open it again.',
  expired: 'This has expired. Open it again for a fresh one.',
  not_offered: 'Pay once is not possible here: the account pays only the address on file.',
  insufficient_funds: 'The account does not hold enough USDC for this.',
  already_paused: 'The account is already paused.',
  not_paused: 'The account is not paused.',
  bad_deadline: 'This was open too long to sign. Open it again.',
  bad_owners:
    'That set of owners is not allowed: one to five different passkeys, and thresholds within it.',
  invalid_public_key: 'That passkey’s public key could not be read.',
  not_created: 'The account has not been created yet.',
  not_hosted: 'The demo agent only pays into demo accounts it hosts.',
  code_expired: 'That WhatsApp code has expired. Make a new one.',
  code_used: 'That WhatsApp code was already used. Make a new one.',
  too_many_codes: 'Too many WhatsApp codes just now. Try again in a few minutes.',
  // 503 when no relayer can pay the network fee (13 Oct: seen as "could not answer"). The owner
  // never sees gas or MON, so say what it means for them.
  relayers_low:
    'Countersign’s testnet service is waiting for a top-up, so nothing was created or paid. Try again in a few minutes.',
};

/** A gateway error in plain words, for the screen. */
export function problemText(status: number, body: { error?: string; message?: string }): string {
  const known = body.error ? WORDS[body.error] : undefined;
  if (body.error === 'contract_refuses' || body.error === 'invalid_bank')
    return `${known ?? 'The account’s contract refused it.'}${body.message ? ` (${body.message})` : ''}`;
  if (known) return known;
  if (status >= 500) return 'Countersign could not answer just now. Try again.';
  return body.message ?? `Something went wrong (${String(status)}). Try again.`;
}

/**
 * A call to the gateway: the JSON answer, or a GatewayError in plain words. The answer's type is
 * the caller's, from the gateway's documented schemas (its /docs); it is not checked at run time.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function call<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
    });
  } catch {
    // No answer at all: no connection, or a browser that refused the call (a refused preflight
    // left the inbox on "Reading…" on 9 Oct). The browser's own words ("Failed to fetch", "Load
    // failed") say nothing to an owner.
    throw new GatewayError(
      0,
      'unreachable',
      'This phone could not reach Countersign. Check the connection.',
    );
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    throw new GatewayError(res.status, b.error, problemText(res.status, b));
  }
  return { status: res.status, body: body as T };
}
