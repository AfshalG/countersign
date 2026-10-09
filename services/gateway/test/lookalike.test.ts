import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, stringToHex, toHex, type Hex } from 'viem';
import { invoiceHash, supplierId, supplierSlug } from '@countersign/shared';
import { Store } from '../src/db/store.js';
import type { Database } from '../src/db/client.js';
import type { Checker, CheckInput, CheckResult } from '../src/checker.js';
import { checkOne } from '../src/pipeline/check.js';
import { freshDatabase, truncate } from './db/helpers.js';
import { ACCOUNT, AGENT_SIG, FakeChain, SUPPLIER, VAULT } from './fakes.js';

/**
 * 9 Oct (Afshal: "sometimes even invisible"): the same invoice sent again with its number altered
 * so a person cannot tell (a zero-width space, a small L for a one, a Greek letter) has another
 * invoice id, so neither the contract nor the request id sees a duplicate. The gateway compares
 * the number the checker read, as a person sees it, with the invoices already paid to the same
 * supplier, and holds a look-alike.
 */
let database: Database;
let store: Store;
const KALIBRE = supplierId(supplierSlug('Kalibre Studio'));
const VAULT_2: Hex = '0x2222222222222222222222222222222222222222';

/** A checker that releases, reporting the number it read off the invoice. */
class Reading implements Checker {
  check(input: CheckInput): Promise<CheckResult> {
    const number = (input.request.document as { number: string }).number;
    return Promise.resolve({
      verdict: 'release',
      checkerSig: `0x${'ab'.repeat(65)}`,
      evidence: { checker: 'reading', read: { number } },
    });
  }
}
const deps = () => ({
  store,
  chain: new FakeChain(),
  checker: new Reading(),
  chainId: 10143,
  checkerTimeoutMs: 2_000,
});

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
  for (const [vault, supplier, order] of [
    [VAULT, KALIBRE, 'order 1'],
    [VAULT_2, supplierId(supplierSlug('Northwind Prints')), 'order 2'],
  ] as const)
    await store.upsertOrder({
      vault,
      account: ACCOUNT,
      orderId: keccak256(stringToHex(order)),
      supplierId: supplier,
      orderHash: keccak256(stringToHex(`${order} quote`)),
      amount: '50000',
      expiry: 2_000_000_000,
      approvedBlock: 1,
    });
});

async function paid(number: string, vault: Hex = VAULT): Promise<Hex> {
  const id = keccak256(toHex(`${vault} ${number}`));
  await store.createRequest({
    id,
    account: ACCOUNT,
    vault,
    invoiceHash: invoiceHash(KALIBRE, number),
    payTo: SUPPLIER,
    amount: 1000n,
    deadline: 2_000_000_000,
    agentSig: AGENT_SIG,
    agentAddress: null,
    document: { number },
  });
  const row = await store.get(id);
  if (!row) throw new Error('no row');
  await checkOne(deps(), row);
  return id;
}

describe('a look-alike of an invoice already paid', () => {
  it('is held as a duplicate, naming the invoice it copies', async () => {
    const first = await paid('INV-1001');
    expect((await store.get(first))?.status).toBe('released');
    for (const copy of ['INV-1001​', 'INV-l001', 'inv 1001', 'ΙNV-1001']) {
      const id = await paid(copy);
      const row = await store.get(id);
      expect(row?.status, JSON.stringify(copy)).toBe('held');
      expect(row?.reason).toBe('duplicate_invoice');
      expect(row?.evidence).toMatchObject({ duplicateOf: { id: first, number: 'INV-1001' } });
    }
  });

  it('is not a duplicate for another supplier, or for another number', async () => {
    await paid('INV-1001');
    expect((await store.get(await paid('INV-1001', VAULT_2)))?.status).toBe('released');
    expect((await store.get(await paid('INV-1002')))?.status).toBe('released');
  });

  it('is caught when the two are checked at the same moment', async () => {
    const ids = await Promise.all([paid('INV-2001'), paid('INV-2OO1')]);
    const statuses = await Promise.all(ids.map(async (id) => (await store.get(id))?.status));
    expect(statuses.sort()).toEqual(['held', 'released']);
  });
});
