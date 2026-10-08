import { describe, expect, it } from 'vitest';
import recorded from '../test/fixtures/attestation-supplier.json' with { type: 'json' };
import { PRIMUS_ATTESTOR, expectedPayToData, toSolidityAttestation } from './encode.js';

describe('toSolidityAttestation', () => {
  it('maps a real Primus attestation field for field, keeping Primus spelling', () => {
    const att = toSolidityAttestation(recorded);
    expect(att.recipient).toBe(recorded.recipient);
    expect(att.request).toEqual(recorded.request);
    expect(att.reponseResolve).toEqual(recorded.reponseResolve);
    expect(att.data).toBe(recorded.data);
    expect(att.attConditions).toBe(recorded.attConditions);
    expect(att.additionParams).toBe(recorded.additionParams);
    expect(att.attestors).toEqual(recorded.attestors);
    expect(att.signatures).toEqual(recorded.signatures);
  });

  it('keeps the timestamp in milliseconds, as a uint64', () => {
    const att = toSolidityAttestation(recorded);
    expect(att.timestamp).toBe(BigInt(recorded.timestamp));
    expect(att.timestamp > 1_000_000_000_000n).toBe(true);
  });

  it('was signed by Primus attestor', () => {
    expect(recorded.attestors[0]?.attestorAddr.toLowerCase()).toBe(PRIMUS_ATTESTOR.toLowerCase());
  });

  it.each([
    ['no signature', { ...recorded, signatures: [] }],
    [
      'two signatures',
      { ...recorded, signatures: [recorded.signatures[0], recorded.signatures[0]] },
    ],
    ['a short signature', { ...recorded, signatures: ['0x1234'] }],
    ['a missing data field', { ...recorded, data: undefined }],
    ['a bad recipient', { ...recorded, recipient: '0x123' }],
    ['a negative timestamp', { ...recorded, timestamp: -1 }],
  ])('refuses %s before any gas is spent', (_label, bad) => {
    expect(() => toSolidityAttestation(bad)).toThrow();
  });
});

describe('expectedPayToData', () => {
  it('builds exactly the data string Primus attests for a supplier file', () => {
    expect(expectedPayToData('0x90f9931B748B26763161a8191C178Fe425C25fEc')).toBe(recorded.data);
  });

  it('uses the checksummed form even when given lowercase', () => {
    expect(expectedPayToData('0x90f9931b748b26763161a8191c178fe425c25fec')).toBe(recorded.data);
  });
});
