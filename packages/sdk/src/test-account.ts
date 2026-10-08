import {
  createECDH,
  createHash,
  createPrivateKey,
  randomBytes,
  sign as ecdsaSign,
  type KeyObject,
} from 'node:crypto';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CountersignError } from './errors.js';

/**
 * A testnet account a developer makes alone (Slice 12 part 2), in Node. The owner is a P-256 key
 * in a file standing in for a passkey on a phone, so this is for test accounts only: a real
 * account's owner signs with Face ID. The agent key is the developer's own; both keys stay here.
 */

/** The P-256 group order: the contract accepts only signatures with s at most half of it. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const RP_ID = 'countersign.test';
const ORIGIN = 'https://countersign.test';
const USER_PRESENT_AND_VERIFIED = 0x05;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const hex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** A WebAuthn assertion as a browser gives it, which the gateway's passkey routes take. */
export type Assertion = {
  authenticatorData: Hex;
  clientDataJSON: string;
  signature: { r: Hex; s: Hex };
};

/**
 * A software stand-in for an owner's passkey: it signs the challenge as a phone does
 * (sha256 of authenticatorData and the hash of clientDataJSON, user verified, low s).
 */
export class TestOwner {
  private constructor(
    private readonly key: KeyObject,
    readonly privateKey: Hex,
    readonly x: Hex,
    readonly y: Hex,
  ) {}

  static random(): TestOwner {
    for (;;) {
      const d = BigInt(`0x${randomBytes(32).toString('hex')}`);
      if (d > 0n && d < P256_N) return TestOwner.fromPrivateKey(hex32(d));
    }
  }

  static fromPrivateKey(privateKey: Hex): TestOwner {
    const d = BigInt(privateKey);
    if (d <= 0n || d >= P256_N) throw new Error('not a P-256 private key');
    const dBytes = Buffer.from(hex32(d).slice(2), 'hex');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(dBytes);
    const point = ecdh.getPublicKey(); // 0x04 || x || y
    const x = point.subarray(1, 33);
    const y = point.subarray(33, 65);
    const key = createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: dBytes.toString('base64url'),
        x: x.toString('base64url'),
        y: y.toString('base64url'),
      },
    });
    return new TestOwner(key, hex32(d), `0x${x.toString('hex')}`, `0x${y.toString('hex')}`);
  }

  /** Signs a 32-byte challenge (an EIP-712 digest) as a user-verified passkey assertion. */
  sign(challenge: Hex): Assertion {
    if (!/^0x[0-9a-fA-F]{64}$/.test(challenge)) throw new Error('the challenge must be 32 bytes');
    const encoded = Buffer.from(challenge.slice(2), 'hex').toString('base64url');
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${encoded}","origin":"${ORIGIN}","crossOrigin":false}`;
    const authenticatorData = Buffer.concat([
      sha256(RP_ID),
      Buffer.from([USER_PRESENT_AND_VERIFIED]),
      Buffer.from([0, 0, 0, 1]),
    ]);
    const signature = ecdsaSign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      { key: this.key, dsaEncoding: 'ieee-p1363' },
    );
    const r = BigInt(`0x${signature.subarray(0, 32).toString('hex')}`);
    let s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
    if (s > P256_N / 2n) s = P256_N - s;
    return {
      authenticatorData: `0x${authenticatorData.toString('hex')}`,
      clientDataJSON,
      signature: { r: hex32(r), s: hex32(s) },
    };
  }
}

export type TestAccount = {
  gateway: string;
  /** The Countersign account (the contract that holds the test USDC). */
  account: Address;
  /** Reaches only this account; pass it as `token` to `new Countersign(...)`. */
  token: string;
  /** The agent's key, named in the account's policy: pass it as `agentKey`. */
  agentKey: Hex;
  agent: Address;
  /** The owner's P-256 key (test accounts only): decides holds with `decide()`. */
  ownerKey: Hex;
  /** The demo order the account opened with Kalibre Studio, the demo supplier. */
  order: { orderId: Hex; supplier: string; payTo: Address; amountUsdc: string } | null;
};

type Options = {
  /** Default: the hosted testnet gateway. */
  gateway?: string;
  /** Wait until the order is indexed, so `orders()` lists it at once (default true, up to 60 s). */
  waitForOrder?: boolean;
  fetch?: typeof fetch;
};

const DEFAULT_GATEWAY = 'https://gateway-production-e17a.up.railway.app';

async function call<T>(
  f: typeof fetch,
  method: string,
  url: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await f(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new CountersignError(
      'network',
      `could not reach the gateway: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok)
    throw new CountersignError(
      json.error ?? `http_${String(res.status)}`,
      json.message ?? `${method} ${url} answered ${String(res.status)}`,
      res.status,
    );
  return json;
}

/**
 * Makes a testnet account for your own agent: new owner and agent keys here, the account created
 * and funded with 0.01 test USDC, its policy, the demo supplier and a 0.005 USDC order signed by
 * the owner key, then a token for this account only. Takes about ten seconds on testnet.
 */
export async function createTestAccount(options: Options = {}): Promise<TestAccount> {
  const gateway = (options.gateway ?? DEFAULT_GATEWAY).replace(/\/$/, '');
  const f = options.fetch ?? fetch;
  const owner = TestOwner.random();
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey).address;

  type View = {
    account: Address;
    status: string;
    actions: { challenge: Hex }[];
    order: TestAccount['order'];
  };
  const created = await call<View>(f, 'POST', `${gateway}/v1/demo/accounts`, {
    publicKey: { x: owner.x, y: owner.y },
    agent,
  });
  const ready = await call<View>(
    f,
    'POST',
    `${gateway}/v1/demo/accounts/${created.account}/setup`,
    {
      assertions: created.actions.map((a) => owner.sign(a.challenge)),
    },
  );
  const ask = await call<{ challenge: Hex }>(
    f,
    'GET',
    `${gateway}/v1/demo/accounts/${created.account}/token`,
  );
  const { token } = await call<{ token: string }>(
    f,
    'POST',
    `${gateway}/v1/demo/accounts/${created.account}/token`,
    { assertion: owner.sign(ask.challenge) },
  );

  if (options.waitForOrder ?? true) {
    // The order is indexed from finalized blocks, a few seconds after it is approved.
    const until = Date.now() + 60_000;
    for (;;) {
      const { orders } = await call<{ orders: unknown[] }>(
        f,
        'GET',
        `${gateway}/v1/accounts/${created.account}/orders`,
        undefined,
        token,
      );
      if (orders.length > 0) break;
      if (Date.now() > until)
        throw new CountersignError('order_not_indexed', 'the order was not indexed within 60 s');
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  return {
    gateway,
    account: created.account,
    token,
    agentKey,
    agent,
    ownerKey: owner.privateKey,
    order: ready.order,
  };
}

/**
 * Decides a held payment with the test owner key, as the owner's phone would: `pay_once` (only
 * when the address is the one on file) or `refuse`. Returns the payment's new status.
 */
export async function decide(input: {
  id: string;
  action: 'pay_once' | 'refuse';
  ownerKey: Hex;
  gateway?: string;
  fetch?: typeof fetch;
}): Promise<{ status: string; txHash?: string | null }> {
  const gateway = (input.gateway ?? DEFAULT_GATEWAY).replace(/\/$/, '');
  const f = input.fetch ?? fetch;
  const view = await call<{ actions: Record<string, { challenge: Hex } | undefined> }>(
    f,
    'GET',
    `${gateway}/v1/approvals/${input.id}`,
  );
  const offered = view.actions[input.action];
  if (!offered)
    throw new CountersignError(
      'not_offered',
      `${input.action} is not offered for this payment (offered: ${Object.keys(view.actions).join(', ') || 'nothing'})`,
    );
  const assertion = TestOwner.fromPrivateKey(input.ownerKey).sign(offered.challenge);
  return call(f, 'POST', `${gateway}/v1/approvals/${input.id}`, {
    action: input.action,
    assertion,
  });
}
