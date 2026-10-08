import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/db/store.js';
import type { Database } from '../../src/db/client.js';
import { freshDatabase, truncate } from './helpers.js';

let database: Database;
let store: Store;

beforeAll(async () => {
  database = await freshDatabase();
  store = new Store(database.db);
});
afterAll(async () => {
  await database.pool.end();
});
beforeEach(async () => {
  await truncate(database);
});

const A = '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603';
const B = '0xbd19BbE40044a3175A3213D8408a434b882CADF4';

describe('account tokens (Slice 12 part 2)', () => {
  it('finds a live token by its hash; a new one revokes the old', async () => {
    expect(await store.nextTokenGeneration(A)).toBe(0);
    expect(await store.issueApiToken(A, 'hash-1', 0)).toBe(true);
    expect(await store.apiTokenAccount('hash-1')).toBe(A.toLowerCase());
    expect(await store.nextTokenGeneration(A)).toBe(1);

    expect(await store.issueApiToken(A, 'hash-2', 1)).toBe(true);
    expect(await store.apiTokenAccount('hash-1')).toBeNull();
    expect(await store.apiTokenAccount('hash-2')).toBe(A.toLowerCase());
    expect(await store.apiTokenAccount('unknown')).toBeNull();
  });

  it('gives one token per generation, so one passkey signature makes one token', async () => {
    expect(await store.issueApiToken(A, 'hash-1', 0)).toBe(true);
    expect(await store.issueApiToken(A, 'hash-again', 0)).toBe(false);
    expect(await store.apiTokenAccount('hash-1')).toBe(A.toLowerCase());
    expect(await store.apiTokenAccount('hash-again')).toBeNull();
  });

  it('keeps accounts apart', async () => {
    await store.issueApiToken(A, 'hash-a', 0);
    await store.issueApiToken(B, 'hash-b', 0);
    expect(await store.apiTokenAccount('hash-a')).toBe(A.toLowerCase());
    expect(await store.apiTokenAccount('hash-b')).toBe(B.toLowerCase());
    expect(await store.nextTokenGeneration(B)).toBe(1);
  });
});
