import { describe, expect, it } from 'vitest';
import {
  CONTRACT_REFUSALS,
  FINAL_STATUSES,
  PAYMENT_STATUSES,
  REASONS,
  canTransition,
  isFinal,
  refusalFor,
} from '../src/payment-state.js';

describe('payment request states', () => {
  it('lets a request move only along the drawn paths', () => {
    expect(canTransition('requested', 'checking')).toBe(true);
    expect(canTransition('checking', 'held')).toBe(true);
    expect(canTransition('checking', 'released')).toBe(true);
    expect(canTransition('held', 'released')).toBe(true); // pay once with the passkey
    expect(canTransition('held', 'refused')).toBe(true);
    expect(canTransition('held', 'expired')).toBe(true);
    expect(canTransition('released', 'settling')).toBe(true);
    expect(canTransition('settling', 'settled')).toBe(true);
    expect(canTransition('settling', 'failed')).toBe(true);
  });

  it('never skips the check or settles without sending', () => {
    expect(canTransition('requested', 'released')).toBe(false);
    expect(canTransition('requested', 'settled')).toBe(false);
    expect(canTransition('checking', 'settled')).toBe(false);
    expect(canTransition('held', 'settling')).toBe(false);
  });

  it('never leaves a final status', () => {
    for (const from of FINAL_STATUSES) {
      for (const to of PAYMENT_STATUSES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('knows which statuses are final', () => {
    expect(isFinal('settled')).toBe(true);
    expect(isFinal('held')).toBe(false);
    expect(FINAL_STATUSES).toEqual(['settled', 'blocked', 'refused', 'expired', 'failed']);
  });
});

describe('contract refusals', () => {
  it('maps every named error a payment can raise to a typed reason and a status', () => {
    const errors = [
      'DeadlinePassed',
      'ZeroAmount',
      'AccountPaused',
      'VaultClosed',
      'OrderExpired',
      'AlreadyPaid',
      'SupplierInactive',
      'PayToNotOnFile',
      'AddressNotYetActive',
      'OverNewAddressCap',
      'OverCap',
      'OverRemaining',
      'PolicyNotSet',
      'PolicyExpired',
      'InvalidAgentSignature',
      'InvalidCheckerSignature',
      'InvalidOwnerSignature',
      // D36: a pay-once's owners are checked by the account, so its errors reach the vault too.
      'NotEnoughSigners',
      'OwnersOutOfOrder',
      'UnknownOwner',
    ];
    for (const e of errors) {
      const r = refusalFor(e);
      expect(REASONS).toContain(r.reason);
      expect(['blocked', 'held']).toContain(r.status);
    }
    expect(Object.keys(CONTRACT_REFUSALS).sort()).toEqual([...errors].sort());
  });

  it('holds what a person can resolve and blocks what nobody should pay', () => {
    expect(refusalFor('PayToNotOnFile')).toEqual({ status: 'held', reason: 'address_mismatch' });
    expect(refusalFor('AddressNotYetActive')).toEqual({
      status: 'held',
      reason: 'address_not_yet_active',
    });
    expect(refusalFor('AccountPaused')).toEqual({ status: 'held', reason: 'paused' });
    expect(refusalFor('OverRemaining')).toEqual({ status: 'blocked', reason: 'over_limit' });
    expect(refusalFor('AlreadyPaid')).toEqual({ status: 'blocked', reason: 'duplicate_invoice' });
  });

  it('treats an error it does not know as a hold, never a pass (fail closed)', () => {
    expect(refusalFor('SomethingNew')).toEqual({ status: 'held', reason: 'checker_unavailable' });
  });
});

describe('the checker’s reasons (Slice 10)', () => {
  it('has a reason for instructions aimed at an automated reader', () => {
    expect(REASONS).toContain('hidden_instructions');
  });
});

describe('reason wording', () => {
  it('says every reason in plain words, without contract names', async () => {
    const { REASONS, REASON_TEXT } = await import('../src/payment-state.js');
    for (const reason of REASONS) {
      const text = REASON_TEXT[reason];
      expect(text.length, reason).toBeGreaterThan(10);
      expect(text, reason).not.toMatch(/[A-Z][a-z]+[A-Z][A-Za-z]*/); // no PayToNotOnFile-style names
    }
  });
});
