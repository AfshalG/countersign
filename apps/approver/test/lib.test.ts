import { describe, expect, it } from 'vitest';
import { b64url, hexToBytes } from '../lib/encoding';
import { markDifferences } from '../lib/diff';
import { problemText } from '../lib/gateway';
import { signedMatches, whatIsPaid } from '../lib/verify';
import { hashTypedData } from 'viem';
import { accountDomain, ownerActionTypes, paymentTypes, vaultDomain } from '@countersign/shared';

/** Slice 11: the approver app's pure parts. The screens themselves are tried on a phone. */
describe('encoding for WebAuthn', () => {
  it('turns a challenge (an EIP-712 digest in hex) into the bytes a passkey signs', () => {
    expect([...hexToBytes('0x00ff10')]).toEqual([0, 255, 16]);
    expect(() => hexToBytes('0x0')).toThrow(/hex/);
  });

  it('writes bytes as base64url, as the gateway reads them', () => {
    expect(b64url(new Uint8Array([251, 255, 0]).buffer)).toBe('-_8A');
    expect(b64url(new TextEncoder().encode('{"type":"webauthn.get"}').buffer)).toBe(
      'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
    );
  });
});

describe('two addresses side by side', () => {
  it('marks exactly the characters that differ, so a look-alike shows itself', () => {
    const onFile = '0x90f9931B748B26763161a8191C178Fe425C25fEc';
    const lookAlike = '0x90f9931F1721Ed8D9f47ea45B5E485e6182D5feC';
    const parts = markDifferences(lookAlike, onFile);
    expect(parts.map((p) => p.text).join('')).toBe(lookAlike);
    expect(parts[0]).toEqual({ text: '0x90f9931', differs: false });
    expect(parts.at(-1)).toEqual({ text: '5feC', differs: false });
    expect(parts.some((p) => p.differs)).toBe(true);
  });

  it('ignores letter case, which an address does not depend on', () => {
    expect(markDifferences('0xABCdef', '0xabcDEF')).toEqual([{ text: '0xABCdef', differs: false }]);
  });
});

describe('what went wrong, in plain words', () => {
  it('names the passkey and state problems the gateway answers with', () => {
    expect(problemText(422, { error: 'invalid_passkey' })).toMatch(/not an owner/i);
    expect(problemText(422, { error: 'challenge_mismatch' })).toMatch(/changed/i);
    expect(problemText(409, { error: 'not_held' })).toMatch(/already decided/i);
    expect(problemText(429, { error: 'demo_limit' })).toMatch(/today/i);
    expect(problemText(500, {})).toMatch(/try again/i);
    expect(problemText(409, { error: 'contract_refuses', message: 'PayToNotOnFile' })).toMatch(
      /PayToNotOnFile/,
    );
  });
});

describe('signing exactly what is shown (9 Oct)', () => {
  const VAULT = '0x6c033066C05Eb524119c8C830F937C4bbd17E426';
  const message = {
    amount: 1_500n,
    invoiceHash: `0x${'11'.repeat(32)}`,
    payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEc',
    deadline: 2_000_000_000n,
  } as const;
  const typed = {
    domain: vaultDomain(10143, VAULT),
    types: paymentTypes,
    primaryType: 'Payment' as const,
    message,
  };
  const challenge = hashTypedData(typed);
  // As the gateway sends it: numbers as strings.
  const sent = JSON.parse(
    JSON.stringify(typed, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as unknown;

  it('accepts a challenge that is the digest of the typed data it came with', () => {
    expect(signedMatches(sent, challenge)).toBe(true);
    expect(whatIsPaid(sent)).toEqual({ amountUsdc: '0.0015', payTo: message.payTo });
  });

  it('refuses one that is not: another amount, another address, or nothing to compare', () => {
    const more = JSON.parse(JSON.stringify(sent)) as { message: { amount: string } };
    more.message.amount = '1500000';
    expect(signedMatches(more, challenge)).toBe(false);
    const elsewhere = JSON.parse(JSON.stringify(sent)) as { message: { payTo: string } };
    elsewhere.message.payTo = '0x90f9931F1721Ed8D9f47ea45B5E485e6182D5feC';
    expect(signedMatches(elsewhere, challenge)).toBe(false);
    expect(signedMatches(null, challenge)).toBe(false);
    expect(signedMatches({ nonsense: true }, challenge)).toBe(false);
  });

  it('checks an owner action too: approving an order, numbers sent as strings', () => {
    const domain = accountDomain(10143, '0xC127e7Dbc29d0d38Be3b2e557ce7d796bd2403A9');
    const message = {
      orderId: `0x${'22'.repeat(32)}`,
      supplierId: `0x${'33'.repeat(32)}`,
      orderHash: `0x${'44'.repeat(32)}`,
      amount: 5_000n,
      expiry: 2_000_000_000n,
      nonce: 7n,
      deadline: 1_900_000_000n,
    } as const;
    const challenge = hashTypedData({
      domain,
      types: ownerActionTypes,
      primaryType: 'ApproveOrder',
      message,
    });
    const sentOrder = {
      domain,
      primaryType: 'ApproveOrder',
      types: { ApproveOrder: ownerActionTypes.ApproveOrder },
      message: {
        ...message,
        amount: '5000',
        expiry: '2000000000',
        nonce: '7',
        deadline: '1900000000',
      },
    };
    expect(signedMatches(sentOrder, challenge)).toBe(true);
    expect(
      signedMatches(
        { ...sentOrder, message: { ...sentOrder.message, amount: '50000' } },
        challenge,
      ),
    ).toBe(false);
  });
});
