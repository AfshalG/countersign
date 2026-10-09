'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatUsdc } from '@countersign/shared';
import { call, GatewayError } from '../../lib/gateway';
import { passkeyProblem, signChallenge } from '../../lib/passkey';
import { loadSession } from '../../lib/session';
import { Address, Problem } from '../ui';

/**
 * Suppliers and orders (Slice 11, FEATURES 4): each supplier's address on file, its open orders and
 * what is left; and a supplier's bank account on file (Slice 17), for advice on invoices paid by
 * bank transfer, put there with Face ID.
 */

type Order = {
  orderId: string;
  supplierId: string;
  supplierName: string | null;
  payTo: string;
  supplierActive: boolean;
  activeAfter: number;
  amount: string;
  remaining: string;
  expiry: number;
};
type Bank = { supplierId: string; description: string; updatedAt: string };

const message = (e: unknown) => (e instanceof GatewayError ? e.message : passkeyProblem(e));

export default function Orders() {
  const [account, setAccount] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState({ supplierId: '', holder: '', iban: '', bic: '' });

  const load = useCallback(async (a: string, t: string) => {
    try {
      setOrders(
        (await call<{ orders: Order[] }>(`/v1/accounts/${a}/orders`, { token: t })).body.orders,
      );
      setBanks((await call<{ banks: Bank[] }>(`/v1/accounts/${a}/banks`, { token: t })).body.banks);
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  useEffect(() => {
    const s = loadSession();
    setAccount(s.account);
    setToken(s.token);
    if (s.account && s.token) void load(s.account, s.token);
  }, [load]);

  async function putBank() {
    if (!account || !token) return;
    setProblem(null);
    const bank = {
      holder: form.holder.trim(),
      ...(form.iban.trim() ? { iban: form.iban.trim() } : {}),
      ...(form.bic.trim() ? { bic: form.bic.trim() } : {}),
    };
    try {
      const preview = (
        await call<{ challenge: string; summary: string; bank: unknown }>(
          `/v1/owner/${account}/banks/preview`,
          { method: 'POST', body: { supplierId: form.supplierId, bank } },
        )
      ).body;
      setBusy(`Face ID: ${preview.summary}`);
      const assertion = await signChallenge(preview.challenge, loadSession().credentialId);
      await call(`/v1/owner/${account}/banks`, {
        method: 'POST',
        body: { supplierId: form.supplierId, bank, assertion },
      });
      setNote(
        'On file. Bank-transfer invoices from this supplier are compared with it (advice only).',
      );
      setForm({ supplierId: '', holder: '', iban: '', bic: '' });
      await load(account, token);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  }

  if (!account)
    return (
      <p className="note warn">
        Open your account on the <a href="/">home screen</a> first.
      </p>
    );
  if (!token)
    return (
      <p className="note warn">
        Connect this phone to the account on the <a href="/">home screen</a> to see its suppliers.
      </p>
    );
  const suppliers = new Map<string, Order[]>();
  for (const o of orders ?? [])
    suppliers.set(o.supplierId, [...(suppliers.get(o.supplierId) ?? []), o]);
  const now = Date.now() / 1000;

  return (
    <>
      <h1>Suppliers and orders</h1>
      {busy && (
        <p className="note ok" aria-live="polite">
          {busy}
        </p>
      )}
      {note && <p className="note ok">{note}</p>}
      <Problem text={problem} />
      {orders === null ? (
        <p className="muted small">Reading from Monad…</p>
      ) : orders.length === 0 ? (
        <p className="muted small">
          No open orders. Your agent proposes them from a supplier’s quote.
        </p>
      ) : (
        [...suppliers.entries()].map(([sid, os]) => {
          const first = os[0];
          if (!first) return null;
          const bank = banks.find((b) => b.supplierId.toLowerCase() === sid.toLowerCase());
          return (
            <section className="card" key={sid}>
              <h2>{first.supplierName ?? 'A supplier'}</h2>
              <div>
                <p className="small muted">Address on file (the only one these orders pay)</p>
                <Address value={first.payTo} />
              </div>
              {first.activeAfter > now && (
                <p className="note warn small">
                  New address: payable from {new Date(first.activeAfter * 1000).toLocaleString()}.
                </p>
              )}
              {!first.supplierActive && (
                <p className="note bad small">Switched off by the owner.</p>
              )}
              <div className="list">
                {os.map((o) => (
                  <div className="item" key={o.orderId}>
                    <strong>
                      {formatUsdc(BigInt(o.remaining))} of {formatUsdc(BigInt(o.amount))} USDC left
                    </strong>
                    <span className="small muted">
                      Until {new Date(o.expiry * 1000).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
              <p className="small muted">
                Bank account on file: {bank ? bank.description : 'none (for bank-transfer advice)'}
              </p>
            </section>
          );
        })
      )}

      {orders && orders.length > 0 && (
        <section className="card">
          <h2>Put a supplier’s bank account on file</h2>
          <p className="small muted">
            For invoices paid by bank transfer. Countersign cannot stop a bank transfer, so it gives
            advice: the invoice’s account against this one.
          </p>
          <label>
            Supplier
            <select
              id="bank-supplier"
              value={form.supplierId}
              onChange={(e) => {
                setForm({ ...form, supplierId: e.target.value });
              }}
            >
              <option value="">Choose</option>
              {[...suppliers.entries()].map(([sid, os]) => (
                <option key={sid} value={sid}>
                  {os[0]?.supplierName ?? sid.slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Account holder
            <input
              id="bank-holder"
              value={form.holder}
              onChange={(e) => {
                setForm({ ...form, holder: e.target.value });
              }}
            />
          </label>
          <label>
            IBAN
            <input
              id="bank-iban"
              value={form.iban}
              onChange={(e) => {
                setForm({ ...form, iban: e.target.value });
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            BIC (optional)
            <input
              id="bank-bic"
              value={form.bic}
              onChange={(e) => {
                setForm({ ...form, bic: e.target.value });
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            className="primary"
            onClick={() => void putBank()}
            disabled={!!busy || !form.supplierId || !form.holder || !form.iban}
          >
            Check and sign with Face ID
          </button>
        </section>
      )}
    </>
  );
}
