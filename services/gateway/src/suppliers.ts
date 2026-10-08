import { supplierId, supplierSlug } from '@countersign/shared';
import type { Store } from './db/store.js';

/**
 * A supplier's name for a person to read. On chain a supplier is only an id (keccak256 of its
 * slug); the name comes from the proposal the owner approved, or for the demo supplier set up
 * without one (Slice 5's demo account, judge mode), from here.
 */
const KNOWN: Record<string, string> = {
  [supplierId('kalibre-studio')]: 'Kalibre Studio',
};

export async function supplierNameOf(
  store: Pick<Store, 'orderByVault' | 'approvedSupplierNames'>,
  account: string,
  vault: string,
): Promise<string | null> {
  const order = await store.orderByVault(vault);
  if (!order) return null;
  for (const name of await store.approvedSupplierNames(account)) {
    try {
      if (supplierId(supplierSlug(name)) === order.supplierId) return name;
    } catch {
      // a name with nothing to slug: skip it
    }
  }
  return KNOWN[order.supplierId] ?? null;
}
