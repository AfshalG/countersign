import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';
import {
  compactIban,
  ibanValid,
  REASON_TEXT,
  REASONS,
  routingValid,
  spacedIban,
  supplierId,
  type Reason,
} from '@countersign/shared';
import type { Chain } from './chain/types.js';
import { orderFacts, pageOf, type OrderFacts } from './checker-remote.js';
import type { AdviceCheckRow, SupplierBankRow } from './db/schema.js';
import type { Store } from './db/store.js';

/**
 * Advice on an invoice paid by bank transfer (Slice 17, D14). A bank transfer happens inside the
 * bank, so nothing outside it can stop one: the gateway gathers what the owner approved (the
 * order's supplier and quote, the address and the bank account on file), the checker compares the
 * invoice with it (`POST /v1/advise`), and the agent is told match, mismatch or unsure. The advice
 * is kept for the payment record (Slice 18). No payment request is made and no money moves.
 */

/** A supplier's bank account: an IBAN, or an account number with a UK sort code or US routing. */
export type BankDetails = {
  holder: string;
  iban?: string;
  bic?: string;
  sortCode?: string;
  accountNumber?: string;
  routingNumber?: string;
};

export type AdviceInput = {
  order: OrderFacts;
  bankOnFile: BankDetails | null;
  invoice: { html: string } | { text: string };
};

export type AdviceResult = {
  advice: 'match' | 'mismatch' | 'unsure';
  reason?: Reason;
  evidence: unknown;
};

/** Whoever reads the invoice for advice: the checker service (RemoteChecker), or a fake in tests. */
export interface Advisor {
  advise(input: AdviceInput, signal: AbortSignal): Promise<AdviceResult>;
}

/** The checker has 5 s for advice (it is not on a payment's path); the gateway waits a little more. */
export const ADVICE_TIMEOUT_MS = 8_000;

/**
 * The demo supplier's account, known as its website is (Slice 15's KNOWN_SITES): the demo site's
 * Kalibre Studio prints it on its clean bank invoice (apps/supplier, KALIBRE.bank; a test keeps
 * the two the same). The standard example IBAN: it passes its check digits and names no real
 * account. An owner's own record for the supplier always wins.
 */
export const KNOWN_BANKS: Record<string, BankDetails> = {
  [supplierId('kalibre-studio').toLowerCase()]: {
    holder: 'Kalibre Studio Ltd',
    iban: 'GB29NWBK60161331926819',
    bic: 'NWBKGB2L',
  },
};

export class InvalidBankError extends Error {}

/** One form for every account: compact upper-case IBAN and BIC, digits only for the rest. */
export function normalBank(b: BankDetails): BankDetails {
  const digits = (s: string | undefined) => s?.replace(/\D/g, '') || undefined;
  const out: BankDetails = { holder: b.holder.trim().replace(/\s+/g, ' ') };
  const iban = b.iban ? compactIban(b.iban) : undefined;
  const bic = b.bic?.replace(/\s/g, '').toUpperCase() || undefined;
  const sortCode = digits(b.sortCode);
  const accountNumber = digits(b.accountNumber);
  const routingNumber = digits(b.routingNumber);
  if (iban) out.iban = iban;
  if (bic) out.bic = bic;
  if (sortCode) out.sortCode = sortCode;
  if (accountNumber) out.accountNumber = accountNumber;
  if (routingNumber) out.routingNumber = routingNumber;

  if (out.holder === '') throw new InvalidBankError('the account holder’s name is missing');
  if (!out.iban && !out.accountNumber)
    throw new InvalidBankError('give an IBAN, or an account number');
  if (out.iban && !ibanValid(out.iban))
    throw new InvalidBankError(`the IBAN ${spacedIban(out.iban)} fails its check digits`);
  if (out.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(out.bic))
    throw new InvalidBankError(`${out.bic} is not a BIC`);
  if (out.sortCode && out.sortCode.length !== 6)
    throw new InvalidBankError('a UK sort code has six digits');
  if (out.routingNumber && !routingValid(out.routingNumber))
    throw new InvalidBankError(`the routing number ${out.routingNumber} fails its check digit`);
  if (out.accountNumber && (out.accountNumber.length < 6 || out.accountNumber.length > 17))
    throw new InvalidBankError('an account number has 6 to 17 digits');
  return out;
}

/** The account in words, as the owner sees it before signing and the agent sees it after. */
export function describeBank(b: BankDetails): string {
  const where = b.iban
    ? `IBAN ${spacedIban(b.iban)}`
    : b.sortCode
      ? `sort code ${b.sortCode.replace(/(\d{2})(?=\d)/g, '$1-')}, account ${b.accountNumber ?? ''}`
      : b.routingNumber
        ? `routing ${b.routingNumber}, account ${b.accountNumber ?? ''}`
        : `account ${b.accountNumber ?? ''}`;
  return `${b.holder}, ${where}${b.bic ? `, BIC ${b.bic}` : ''}`;
}

/**
 * What one owner's passkey signs to put a supplier's bank account on file: the chain, the
 * account, the supplier and exactly these details, normalised (S17-1). Off chain, like refusing a
 * proposal: it moves no money, and the contract never pays a bank.
 */
export function bankChallenge(
  chainId: number,
  account: Address,
  supplier: Hex,
  bank: BankDetails,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
      ],
      [
        'Countersign: put a supplier’s bank account on file',
        BigInt(chainId),
        account,
        supplier,
        bank.holder,
        bank.iban ?? '',
        bank.bic ?? '',
        bank.sortCode ?? '',
        bank.accountNumber ?? '',
        bank.routingNumber ?? '',
      ],
    ),
  );
}

export const bankOf = (row: SupplierBankRow): BankDetails =>
  normalBank({
    holder: row.holder,
    ...(row.iban ? { iban: row.iban } : {}),
    ...(row.bic ? { bic: row.bic } : {}),
    ...(row.sortCode ? { sortCode: row.sortCode } : {}),
    ...(row.accountNumber ? { accountNumber: row.accountNumber } : {}),
    ...(row.routingNumber ? { routingNumber: row.routingNumber } : {}),
  });

/** What the agent is told, in plain words; always that it is advice. */
export function adviceSaid(advice: AdviceResult['advice'], reason: Reason | null): string {
  if (advice === 'match')
    return 'Advice: the bank account on this invoice is the supplier’s account on file, and nothing else on it differs from the order. Countersign cannot stop or confirm a bank transfer: it is paid at the bank.';
  const why = reason ? REASON_TEXT[reason] : '';
  if (advice === 'mismatch')
    return reason === 'bank_account_mismatch'
      ? `Advice: do not pay this invoice. ${why}`
      : `Advice: do not pay this invoice. ${why} Ask the owner before paying it at the bank.`;
  return `Advice: unsure. ${why} Before paying it at the bank, confirm the account with the supplier by phone, on a number you already have, not one on the invoice.`;
}

export type AdviceDeps = {
  store: Pick<Store, 'orderByVault' | 'approvedQuote' | 'supplierBank' | 'recordAdvice'>;
  chain: Pick<Chain, 'addressOnFile'>;
  advisor: Advisor;
  timeoutMs?: number;
};

export class UnknownOrderError extends Error {}

/** An answer from the checker is trusted only when well formed; anything else is unsure. */
function wellFormed(out: AdviceResult): AdviceResult {
  const advice = (['match', 'mismatch', 'unsure'] as const).find((a) => a === out.advice);
  const reason = REASONS.find((r) => r === out.reason);
  if (!advice || (advice === 'mismatch' && !reason))
    return { advice: 'unsure', reason: 'checker_unsure', evidence: out.evidence ?? null };
  return { advice, ...(reason ? { reason } : {}), evidence: out.evidence ?? null };
}

export async function adviseOn(
  deps: AdviceDeps,
  input: { account: Address; vault: Address; document: unknown },
): Promise<{
  row: AdviceCheckRow;
  onFile: (BankDetails & { source: 'on_file' | 'demo' }) | null;
}> {
  const order = await deps.store.orderByVault(input.vault);
  if (!order || order.account.toLowerCase() !== input.account.toLowerCase())
    throw new UnknownOrderError('no such order on this account');
  // The chain may not answer: the caller says chain_unavailable, and nothing is recorded.
  const addressOnFile = await deps.chain.addressOnFile(input.account, input.vault);
  const facts = await orderFacts(deps, {
    account: input.account,
    vault: input.vault,
    payTo: addressOnFile,
  });
  if (!facts) throw new UnknownOrderError('no such order on this account');

  const stored = await deps.store.supplierBank(input.account, order.supplierId as Hex);
  const known = KNOWN_BANKS[order.supplierId.toLowerCase()];
  const bankOnFile = stored ? bankOf(stored) : (known ?? null);
  const onFile = bankOnFile
    ? { ...bankOnFile, source: stored ? ('on_file' as const) : ('demo' as const) }
    : null;

  let result: AdviceResult;
  try {
    result = wellFormed(
      await deps.advisor.advise(
        { order: facts, bankOnFile, invoice: pageOf(input.document) },
        AbortSignal.timeout(deps.timeoutMs ?? ADVICE_TIMEOUT_MS),
      ),
    );
  } catch (e) {
    // Money rule 1, as advice: a checker that did not answer is never a match.
    result = {
      advice: 'unsure',
      reason: 'checker_unavailable',
      evidence: { error: e instanceof Error ? e.message : String(e) },
    };
  }
  const document =
    typeof input.document === 'string' ? input.document : JSON.stringify(input.document ?? null);
  const documentHash = keccak256(stringToHex(document));
  const read = (result.evidence as { read?: { number?: unknown } } | null)?.read;
  const row = await deps.store.recordAdvice({
    // One record per (account, order, document): asking again updates it.
    id: keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
        [input.account, input.vault, documentHash],
      ),
    ),
    account: input.account.toLowerCase(),
    vault: input.vault.toLowerCase(),
    supplierId: order.supplierId.toLowerCase(),
    advice: result.advice,
    reason: result.reason ?? null,
    invoiceNumber: typeof read?.number === 'string' ? read.number : null,
    documentHash,
    evidence: result.evidence ?? null,
  });
  return { row, onFile };
}
