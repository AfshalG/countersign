import { describe, expect, it } from 'vitest';
import { compareBank, ibanValid, readBank, type BankOnFile } from '../src/bank.js';

/**
 * Slice 17: bank details read off an invoice and compared with the account the owner put on file.
 * A bank transfer cannot be stopped from outside the bank, so the answer is advice: match,
 * mismatch or unsure.
 */
const ON_FILE: BankOnFile = {
  holder: 'Kalibre Studio Ltd',
  iban: 'GB29NWBK60161331926819',
  bic: 'NWBKGB2L',
};

describe('reading bank details', () => {
  it('checks an IBAN’s check digits', () => {
    expect(ibanValid('GB29NWBK60161331926819')).toBe(true);
    expect(ibanValid('GB33BUKB20201555555555')).toBe(true);
    expect(ibanValid('GB30NWBK60161331926819')).toBe(false);
  });

  it('reads a labelled IBAN, BIC and holder, spaced or run together', () => {
    const r = readBank(
      'Bank transfer\nKalibre Studio Ltd\nIBAN GB33 BUKB 2020 1555 5555 55\nBIC BUKBGB22',
    );
    expect(r).toMatchObject({
      holder: 'Kalibre Studio Ltd',
      ibans: [{ value: 'GB33BUKB20201555555555', valid: true }],
      bics: ['BUKBGB22'],
    });
    // As a page reader leaves it, with the BIC on the same line.
    expect(readBank('IBAN GB29 NWBK 6016 1331 9268 19 BIC NWBKGB2L')).toMatchObject({
      ibans: [{ value: 'GB29NWBK60161331926819', valid: true }],
      bics: ['NWBKGB2L'],
    });
    expect(
      readBank('Bank transfer: Kalibre Studio Ltd, IBAN GB29NWBK60161331926819, BIC NWBKGB2L'),
    ).toMatchObject({ holder: 'Kalibre Studio Ltd', ibans: [{ value: 'GB29NWBK60161331926819' }] });
  });

  it('keeps an IBAN whose check digits fail, marked invalid', () => {
    expect(readBank('IBAN: GB30 NWBK 6016 1331 9268 19').ibans).toEqual([
      { value: 'GB30NWBK60161331926819', valid: false },
    ]);
  });

  it('finds an IBAN with no label, if its check digits hold', () => {
    expect(readBank('From today please send to GB29NWBK60161331926819 instead.').ibans).toEqual([
      { value: 'GB29NWBK60161331926819', valid: true },
    ]);
  });

  it('reads a UK sort code and account number, and a US routing and account number', () => {
    expect(
      readBank('Account name: Kalibre Studio Ltd\nSort code: 60-16-13\nAccount number: 31926819'),
    ).toMatchObject({
      holder: 'Kalibre Studio Ltd',
      sortCodes: ['601613'],
      accountNumbers: ['31926819'],
    });
    expect(
      readBank('Beneficiary: Kalibre Studio Inc\nRouting number 021000021\nAccount no. 123456789'),
    ).toMatchObject({
      holder: 'Kalibre Studio Inc',
      routingNumbers: [{ value: '021000021', valid: true }],
      accountNumbers: ['123456789'],
    });
    expect(readBank('ABA 021000022').routingNumbers).toEqual([
      { value: '021000022', valid: false },
    ]);
  });

  it('reads nothing from an invoice with no bank details', () => {
    expect(readBank('Pay in USDC on Monad to 0x90f9931B748B26763161a8191C178Fe425C25fEc')).toEqual({
      holder: null,
      ibans: [],
      bics: [],
      sortCodes: [],
      routingNumbers: [],
      accountNumbers: [],
    });
  });
});

describe('comparing with the account on file', () => {
  const advise = (text: string, onFile: BankOnFile | null = ON_FILE) =>
    compareBank(readBank(text), onFile);

  it('matches the account on file', () => {
    expect(
      advise('Bank transfer\nKalibre Studio Ltd\nIBAN GB29 NWBK 6016 1331 9268 19\nBIC NWBKGB2L'),
    ).toMatchObject({ advice: 'match' });
    // The same account as a UK sort code and account number (a UK IBAN contains both).
    expect(
      advise('Kalibre Studio Limited\nSort code 60-16-13\nAccount number 31926819'),
    ).toMatchObject({
      advice: 'match',
    });
    expect(
      advise('Account holder: KALIBRE STUDIO LIMITED, IBAN GB29NWBK60161331926819'),
    ).toMatchObject({
      advice: 'match',
    });
  });

  it('calls a different account a mismatch, and says which', () => {
    const a = advise(
      'We have moved to a new bank.\nBank transfer\nKalibre Studio Ltd\nIBAN GB33 BUKB 2020 1555 5555 55\nBIC BUKBGB22',
    );
    expect(a).toMatchObject({ advice: 'mismatch', reason: 'bank_account_mismatch' });
    const bad = a.findings
      .filter((f) => !f.ok)
      .map((f) => f.detail)
      .join(' ');
    expect(bad).toContain('GB33 BUKB 2020 1555 5555 55');
    expect(bad).toContain('GB29 NWBK 6016 1331 9268 19');
  });

  it('calls it a mismatch when any account on the invoice is not the one on file', () => {
    expect(
      advise('IBAN GB29 NWBK 6016 1331 9268 19\nNew account: IBAN GB33 BUKB 2020 1555 5555 55'),
    ).toMatchObject({ advice: 'mismatch', reason: 'bank_account_mismatch' });
    expect(advise('IBAN GB29 NWBK 6016 1331 9268 19\nBIC BUKBGB22')).toMatchObject({
      advice: 'mismatch',
      reason: 'bank_account_mismatch',
    });
  });

  it('is unsure, never a match, when it cannot be sure', () => {
    // Check digits that fail: a misprint or a misread, not proof either way.
    expect(advise('IBAN GB30 NWBK 6016 1331 9268 19')).toMatchObject({
      advice: 'unsure',
      reason: 'checker_unsure',
    });
    expect(advise('Please pay by bank transfer.')).toMatchObject({ advice: 'unsure' });
    expect(advise('IBAN GB29 NWBK 6016 1331 9268 19', null)).toMatchObject({ advice: 'unsure' });
    // The right account in someone else's name.
    expect(
      advise('Account name: Kalibre Payments Ltd\nIBAN GB29 NWBK 6016 1331 9268 19'),
    ).toMatchObject({
      advice: 'unsure',
    });
  });
});
