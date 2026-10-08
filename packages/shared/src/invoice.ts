import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';

/**
 * An invoice's identity (Slice 12, S12-3): the same supplier's same invoice number is one
 * invoice, whatever order it is paid against and however the number was typed. The SDK, the MCP
 * server and the checker all use this, and must match test/fixtures/invoice-ids.json.
 */
export function normalizeInvoiceNumber(invoiceNumber: string): string {
  // NFKC folds full-width and compatibility characters ("ＩＮＶ－００４２" is "INV-0042").
  const normalized = invoiceNumber.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
  if (normalized.length === 0) throw new Error('the invoice number is empty');
  if (normalized.length > 128) throw new Error('the invoice number is longer than 128 characters');
  return normalized;
}

/**
 * The slug a supplier is known by on chain, from its name as a quote or a person writes it:
 * Unicode-normalised (NFKC, so full-width letters count), lower case, and every run of anything
 * else a single hyphen. "Kalibre Studio", "KALIBRE studio." and "Kalibre-Studio" are one supplier.
 */
export function supplierSlug(name: string): string {
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') throw new Error('a supplier name needs at least one letter or digit');
  return slug;
}

/** A supplier's on-chain id: keccak256 of its slug (as in Slice 5, `keccak256("kalibre-studio")`). */
export function supplierId(slug: string): Hex {
  return keccak256(stringToHex(slug));
}

/** keccak256(abi.encode(bytes32 supplierId, string normalizedInvoiceNumber)). */
export function invoiceHash(supplier: Hex, invoiceNumber: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'string' }],
      [supplier, normalizeInvoiceNumber(invoiceNumber)],
    ),
  );
}
