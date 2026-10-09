import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import type { Store } from '../db/store.js';

/**
 * Account tokens (Slice 12 part 2, S12-11). The gateway's service token reaches every account; an
 * account token reaches one: a developer's test account calls the API with it, so the service
 * token never leaves us. Only its SHA-256 is stored.
 */
declare module 'hono' {
  interface ContextVariableMap {
    /** The account (lower case) an account token is limited to; undefined for the service token. */
    scope: string | undefined;
  }
}

export const ACCOUNT_TOKEN_PREFIX = 'cs_';

/** A new account token: the prefix and 32 random bytes, shown once. */
export const newAccountToken = (): string =>
  `${ACCOUNT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * What an owner's passkey signs to get the account's next token. The generation (how many tokens
 * the account has had) is in it, so a signature that made one token can't make another.
 */
export function tokenChallenge(chainId: number, account: Address, generation: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
      ['Countersign: API token', BigInt(chainId), account, BigInt(generation)],
    ),
  );
}

/**
 * The routes an account token may call, each about its own account (the handlers compare the
 * account). Anything else is refused, so a route added later is never open to one by mistake.
 */
const ACCOUNT_ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/v1\/payments$/ },
  { method: 'POST', path: /^\/v1\/runs$/ },
  { method: 'POST', path: /^\/v1\/checks$/ },
  { method: 'POST', path: /^\/v1\/advice$/ },
  { method: 'GET', path: /^\/v1\/accounts\/[^/]+\/banks$/ },
  { method: 'GET', path: /^\/v1\/payments\/[^/]+$/ },
  { method: 'GET', path: /^\/v1\/runs\/[^/]+$/ },
  { method: 'POST', path: /^\/v1\/payments\/[^/]+\/(approve|refuse)$/ },
  { method: 'GET', path: /^\/v1\/feed$/ },
  { method: 'POST', path: /^\/v1\/accounts$/ },
  { method: 'GET', path: /^\/v1\/accounts\/[^/]+\/orders$/ },
  { method: 'GET', path: /^\/v1\/accounts\/[^/]+\/runs$/ },
  { method: 'POST', path: /^\/v1\/proposals$/ },
  { method: 'GET', path: /^\/v1\/proposals\/[^/]+$/ },
];

const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const unauthorized = (c: Context) =>
  c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm=""' });

/** The service token, or a live account token on one of its routes. */
export function requireToken(
  serviceToken: string,
  store: Pick<Store, 'apiTokenAccount'>,
): MiddlewareHandler {
  return async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (token === undefined) return unauthorized(c);
    if (sameSecret(token, serviceToken)) {
      c.set('scope', undefined);
      await next();
      return;
    }
    if (!token.startsWith(ACCOUNT_TOKEN_PREFIX)) return unauthorized(c);
    const account = await store.apiTokenAccount(hashToken(token));
    if (account === null) return unauthorized(c);
    const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
    if (!ACCOUNT_ROUTES.some((r) => r.method === method && r.path.test(c.req.path)))
      return c.json(
        {
          error: 'not_for_account_tokens',
          message: 'an account token can only call its own account’s routes',
        },
        403,
      );
    c.set('scope', account);
    await next();
  };
}

/** True if the caller may act for `account`: the service token, or that account's own token. */
export function mayUse(c: Context, account: string): boolean {
  const scope = c.get('scope');
  return scope === undefined || scope === account.toLowerCase();
}

export const wrongAccount = {
  error: 'wrong_account',
  message: 'this token belongs to another account',
} as const;
