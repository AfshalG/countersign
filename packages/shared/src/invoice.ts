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

/** Latin capitals that Greek and Cyrillic letters imitate, after upper-casing. */
const IMITATES: Record<string, string> = {
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  У: 'Y',
  І: 'I',
  Ј: 'J',
  Ѕ: 'S',
  Ԛ: 'Q',
  Ԝ: 'W',
};
/** Latin letters and digits a person mistakes for one another in an invoice number. */
const READS_AS: Record<string, string> = { O: '0', I: '1', L: '1' };

/**
 * What an invoice number looks like to a person (9 Oct): its characters without the invisible ones
 * (no width, reading-order controls), letters from another alphabet that imitate Latin ones read as
 * those, O as 0 and I or L as 1, and only letters and digits kept. Two numbers a person cannot tell
 * apart have the same skeleton, so a second copy of an invoice is caught even when its number was
 * altered invisibly. It is not the invoice's identity (`invoiceHash` keeps the number as written):
 * the gateway compares skeletons only to hold a look-alike of an invoice already paid.
 */
export function invoiceSkeleton(invoiceNumber: string): string {
  let s = invoiceNumber
    .normalize('NFKC')
    .replace(/[\p{Cf}ᅟᅠㅤﾠ]/gu, '')
    .toUpperCase();
  // A number wholly in another alphabet is a language, not a look-alike: left as it is.
  if (/\p{Script=Latin}/u.test(s)) s = Array.from(s, (c) => IMITATES[c] ?? c).join('');
  s = Array.from(s, (c) => READS_AS[c] ?? c).join('');
  return s.replace(/[^\p{L}\p{N}]/gu, '');
}
