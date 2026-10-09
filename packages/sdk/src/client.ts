import {
  getAddress,
  hashTypedData,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FINAL_STATUSES,
  invoiceHash,
  paymentTypes,
  REASON_TEXT,
  usdc,
  vaultDomain,
  type Reason,
} from '@countersign/shared';
import { CountersignError, type Issue } from './errors.js';
import { parseEvents } from './feed.js';
import type {
  Advice,
  CheckVerdict,
  Invoice,
  Order,
  PayInput,
  PaymentRequest,
  PaymentResult,
  Proposal,
  Run,
  RunView,
  StatusChange,
} from './types.js';
import type { PaymentRecord } from './verify.js';

export type CountersignOptions = {
  /** The gateway's URL, e.g. https://gateway-production-e17a.up.railway.app */
  gateway: string;
  /** Your account's token (`cs_…`, from `countersign-test-account`), or the gateway's service token. */
  token: string;
  /** The Countersign account (the contract that holds the money). */
  account: Address;
  /**
   * SDK mode: the agent's key, which signs each payment here and never leaves your process. The
   * account's policy names this key's address as its agent. Not needed to read.
   */
  agentKey?: Hex | LocalAccount;
  /** Monad testnet (10143, the default) or mainnet (143). */
  chainId?: number;
  /** A fetch to use instead of the global one (tests, edge runtimes). */
  fetch?: typeof fetch;
};

export type WaitOptions = {
  /** How long to wait for settled, held or blocked; default 30 s. Then the latest status returns. */
  timeoutMs?: number;
  pollMs?: number;
};

/** The vault-domain EIP-712 digest of a payment: what the agent, the checker and the owner sign. */
export function paymentDigest(
  chainId: number,
  vault: Hex,
  payment: { amount: bigint; invoiceHash: Hex; payTo: Hex; deadline: bigint },
): Hex {
  return hashTypedData({
    domain: vaultDomain(chainId, vault),
    types: paymentTypes,
    primaryType: 'Payment',
    message: payment,
  });
}

const reasonText = (reason: string | null): string | null =>
  reason !== null && reason in REASON_TEXT ? REASON_TEXT[reason as Reason] : null;

/** A status that will not change without a person: final, or held for the owner. */
const settledOrHeld = (status: string) =>
  status === 'held' || (FINAL_STATUSES as readonly string[]).includes(status);

/**
 * A Countersign account, as an agent uses it. The account's contract on Monad decides what can
 * be paid: only suppliers on file, at their addresses on file, within approved orders. The agent
 * proposes and pays; anything outside the rules waits for the owner's passkey.
 *
 * ```ts
 * const cs = new Countersign({ gateway, token, account, agentKey });
 * const [order] = await cs.orders();
 * const result = await cs.pay({ order, invoice: { number: 'INV-0042', amount: '12.50', payTo }, wait: true });
 * ```
 */
export class Countersign {
  private readonly base: string;
  private readonly agent: LocalAccount | undefined;
  private readonly chainId: number;
  private readonly fetchFn: typeof fetch;
  readonly account: Address;

  constructor(private readonly options: CountersignOptions) {
    this.base = options.gateway.replace(/\/+$/, '');
    this.account = getAddress(options.account);
    this.chainId = options.chainId ?? 10143;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    const key = options.agentKey;
    this.agent =
      key === undefined ? undefined : typeof key === 'string' ? privateKeyToAccount(key) : key;
  }

  // ---------- reading ----------

  /** Open orders: supplier, its address on file, what is left (read from the chain now), expiry. */
  async orders(): Promise<Order[]> {
    const list = await this.request<{ orders: Order[] }>(
      'GET',
      `/v1/accounts/${this.account}/orders`,
    );
    return list.orders;
  }

  /** Index this account's orders, from its creation block to see every order. Safe to call twice. */
  async register(
    options: { fromBlock?: number; label?: string } = {},
  ): Promise<{ indexedTo: number }> {
    return this.request('POST', '/v1/accounts', { account: this.account, ...options });
  }

  async status(id: string): Promise<PaymentRequest> {
    return withText(await this.request<RawRequest>('GET', `/v1/payments/${id}`));
  }

  async run(id: string): Promise<RunView> {
    const run = await this.request<Omit<RunView, 'requests'> & { requests: RawRequest[] }>(
      'GET',
      `/v1/runs/${id}`,
    );
    return { ...run, requests: run.requests.map(withText) };
  }

  /**
   * A payment's record (Slice 18): one file with the payment, the document, the checks and their
   * evidence hash, the decision and where it is on Monad, and the settlement. Check it with
   * `verifyRecord`, or `npx countersign-verify <file>`.
   */
  async record(id: string): Promise<PaymentRecord> {
    return this.request('GET', `/v1/payments/${id}/record`);
  }

  async proposal(id: string): Promise<Proposal> {
    return this.request('GET', `/v1/proposals/${id}`);
  }

  // ---------- paying ----------

  /**
   * Pays an invoice against an order. The same invoice (supplier and number) is the same request,
   * however often it is sent. With `wait`, returns once it is settled, held or blocked.
   */
  async pay(input: PayInput & { wait?: boolean | WaitOptions }): Promise<PaymentResult> {
    const body = await this.submission(input);
    const { request, created } = await this.request<{ request: RawRequest; created: boolean }>(
      'POST',
      '/v1/payments',
      { account: this.account, ...body },
    );
    const duplicate = !created;
    const first = withText(request);
    if (input.wait === undefined || input.wait === false) return { ...first, duplicate };
    const latest = await this.waitFor(first.id, input.wait === true ? {} : input.wait, first);
    return { ...latest, duplicate };
  }

  /** The same check as `pay`, with nothing paid or stored: would it settle, be held or blocked? */
  async check(input: PayInput): Promise<CheckVerdict> {
    const verdict = await this.request<Omit<CheckVerdict, 'reasonText'>>('POST', '/v1/checks', {
      account: this.account,
      ...(await this.submission(input)),
    });
    return { ...verdict, reasonText: reasonText(verdict.reason) };
  }

  /**
   * Advice on an invoice paid by bank transfer (Slice 17): its bank account against the one on
   * file for the order's supplier, and the same checks as a USDC invoice. Countersign cannot stop
   * a bank transfer, so nothing is paid: on `mismatch`, do not pay it; on `unsure`, confirm the
   * account with the supplier by phone, on a number you already have. Needs no agent key.
   */
  async advise(input: {
    order: Order | Hex;
    document: string | { html: string } | { text: string };
  }): Promise<Advice> {
    const order = await this.resolve(input.order);
    return this.request('POST', '/v1/advice', {
      account: this.account,
      vault: order.vault,
      document: input.document,
    });
  }

  /** A run of up to 500 invoices; follow it with `run(id)` or `watch({ runId })`. */
  async payMany(inputs: PayInput[]): Promise<Run> {
    const orders = inputs.some((i) => typeof i.order === 'string') ? await this.orders() : [];
    const payments = [];
    for (const input of inputs) payments.push(await this.submission(input, orders));
    return this.request('POST', '/v1/runs', { account: this.account, payments });
  }

  /** Waits until a request is settled, held or blocked (or the time runs out). */
  async waitFor(
    id: string,
    options: WaitOptions = {},
    first?: PaymentRequest,
  ): Promise<PaymentRequest> {
    const until = Date.now() + (options.timeoutMs ?? 30_000);
    let latest = first ?? (await this.status(id));
    while (!settledOrHeld(latest.status) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
      latest = await this.status(id);
    }
    return latest;
  }

  /**
   * Live status changes (Server-Sent Events), for one run or all of this gateway's requests.
   * Ends when `signal` aborts or the connection closes; reconnect by calling it again.
   */
  async *watch(
    options: { runId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<StatusChange> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/v1/feed`, {
        headers: { authorization: `Bearer ${this.options.token}`, accept: 'text/event-stream' },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (e) {
      throw new CountersignError('network', `could not reach the gateway: ${message(e)}`);
    }
    if (!res.ok || !res.body)
      throw new CountersignError(`http_${String(res.status)}`, 'the feed refused', res.status);
    // Stop as soon as the caller aborts, even where a runtime does not tie the abort to the body
    // (it would otherwise wait for the next keep-alive, up to 15 s).
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
    const stop = () => {
      reader.cancel().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    }
    try {
      for await (const { event, data } of parseEvents(chunks())) {
        if (event !== 'status') continue;
        const change = JSON.parse(data) as StatusChange;
        if (options.runId === undefined || change.runId === options.runId) yield change;
      }
    } catch (e) {
      if (options.signal?.aborted === true) return;
      throw e;
    } finally {
      options.signal?.removeEventListener('abort', stop);
      stop();
    }
  }

  // ---------- proposing ----------

  /**
   * Proposes a supplier and an order from a quote or contract the agent read. Returns a link for
   * the owner; nothing changes until their passkey signs (and a new address then waits out the
   * account's waiting period).
   */
  async proposeOrder(input: {
    supplier: { name: string; website?: string; payTo: Address };
    amount: string | bigint;
    expiry: Date | number;
    /** The quote as the agent read it: its text, its bytes, or its fields. */
    document: string | Uint8Array | Record<string, unknown>;
  }): Promise<Proposal> {
    const bytes =
      typeof input.document === 'string'
        ? stringToBytes(input.document)
        : input.document instanceof Uint8Array
          ? input.document
          : stringToBytes(JSON.stringify(input.document));
    const expiry =
      input.expiry instanceof Date ? Math.floor(input.expiry.getTime() / 1000) : input.expiry;
    const { proposal } = await this.request<{ proposal: Proposal }>('POST', '/v1/proposals', {
      account: this.account,
      supplier: input.supplier,
      order: { amount: amountOf(input.amount).toString(), expiry },
      documentHash: keccak256(bytes),
      document: typeof input.document === 'string' ? input.document : undefined,
    });
    return proposal;
  }

  // ---------- internals ----------

  private async submission(input: PayInput, known?: Order[]) {
    if (!this.agent)
      throw new CountersignError('no_agent_key', 'paying needs the agent key (agentKey option)');
    const order = await this.resolve(input.order, known);
    const invoice: Invoice = input.invoice;
    const payment = {
      amount: amountOf(invoice.amount),
      invoiceHash: invoiceHash(order.supplierId, invoice.number),
      payTo: getAddress(invoice.payTo),
      deadline: BigInt(input.deadline ?? Math.floor(Date.now() / 1000) + 3600),
    };
    const agentSig = await this.agent.signTypedData({
      domain: vaultDomain(this.chainId, order.vault),
      types: paymentTypes,
      primaryType: 'Payment',
      message: payment,
    });
    return {
      vault: order.vault,
      payment: {
        amount: payment.amount.toString(),
        invoiceHash: payment.invoiceHash,
        payTo: payment.payTo,
        deadline: Number(payment.deadline),
      },
      agentSig,
      ...(invoice.document === undefined ? {} : { document: invoice.document }),
    };
  }

  private async resolve(order: Order | Hex, known?: Order[]): Promise<Order> {
    if (typeof order !== 'string') return order;
    const found = (known ?? (await this.orders())).find(
      (o) => o.orderId.toLowerCase() === order.toLowerCase(),
    );
    if (!found)
      throw new CountersignError('unknown_order', `no open order ${order} on this account`);
    return found;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new CountersignError('network', `could not reach the gateway: ${message(e)}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new CountersignError(
        'bad_response',
        `the gateway answered ${String(res.status)} without JSON`,
        res.status,
      );
    }
    if (!res.ok) {
      const { error, issues, ...details } = (json ?? {}) as { error?: string; issues?: Issue[] };
      throw new CountersignError(
        error ?? `http_${String(res.status)}`,
        error ?? res.statusText,
        res.status,
        issues,
        details,
      );
    }
    return json as T;
  }
}

type RawRequest = Omit<PaymentRequest, 'reasonText'>;

function withText(r: RawRequest): PaymentRequest {
  return { ...r, reasonText: reasonText(r.reason) };
}

function amountOf(amount: string | bigint): bigint {
  if (typeof amount === 'bigint') {
    if (amount <= 0n) throw new CountersignError('malformed', 'the amount must be positive');
    return amount;
  }
  const units = usdc(amount);
  if (units === 0n) throw new CountersignError('malformed', 'the amount must be positive');
  return units;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
