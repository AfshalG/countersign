import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { requestId, runId } from '../src/ids.js';

const account = '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603';
const vault = '0xbd19BbE40044a3175A3213D8408a434b882CADF4';
const invoice = keccak256(toHex('invoice INV-0042'));

describe('requestId', () => {
  it('is the same for the same account, order vault and invoice, so a retry or a second agent gets the same request', () => {
    expect(requestId(account, vault, invoice)).toBe(requestId(account, vault, invoice));
  });

  it('ignores address capitalisation', () => {
    expect(
      requestId(
        account.toLowerCase() as `0x${string}`,
        vault.toUpperCase().replace('0X', '0x') as `0x${string}`,
        invoice,
      ),
    ).toBe(requestId(account, vault, invoice));
  });

  it('differs when the invoice, the vault or the account differs', () => {
    const base = requestId(account, vault, invoice);
    expect(requestId(account, vault, keccak256(toHex('another invoice')))).not.toBe(base);
    expect(requestId(account, account, invoice)).not.toBe(base);
    expect(requestId(vault, vault, invoice)).not.toBe(base);
  });
});

describe('runId', () => {
  it('is the same for the same invoices in any order', () => {
    const a = requestId(account, vault, invoice);
    const b = requestId(account, vault, keccak256(toHex('invoice INV-0043')));
    expect(runId(account, [a, b])).toBe(runId(account, [b, a]));
  });

  it('differs for a different set', () => {
    const a = requestId(account, vault, invoice);
    expect(runId(account, [a])).not.toBe(
      runId(account, [a, a.replace(/.$/, '0') as `0x${string}`]),
    );
  });
});
