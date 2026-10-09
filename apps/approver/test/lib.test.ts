import { describe, expect, it } from 'vitest';
import { b64url, hexToBytes } from '../lib/encoding';
import { markDifferences } from '../lib/diff';
import { problemText } from '../lib/gateway';

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
