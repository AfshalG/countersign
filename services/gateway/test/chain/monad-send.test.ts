import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonadClient } from '../../src/chain/monad.js';

/**
 * Slice 16: sending through the public endpoints at volume. Each endpoint's sends are paced to its
 * budget, and a rate limit (HTTP 429, or a JSON-RPC "request limit" answer) is a reason to slow
 * down and try again, never a refusal that abandons the transaction.
 */
const ENDPOINTS = [
  { url: 'https://a.test', sendsPerSecond: 10, readsPerSecond: 8 },
  { url: 'https://b.test', sendsPerSecond: 10, readsPerSecond: 8 },
];
const client = () =>
  new MonadClient(ENDPOINTS, 'wss://unused.test', '0x0000000000000000000000000000000000000001');

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('sending a transaction', () => {
  it('paces each endpoint’s sends to its budget', async () => {
    const at: number[] = [];
    vi.stubGlobal('fetch', () => {
      at.push(Date.now());
      return answer({ jsonrpc: '2.0', id: 1, result: '0xabc' });
    });
    const c = client();
    await Promise.all(Array.from({ length: 4 }, () => c.send(0, '0x01')));
    // 10 a second: four sends span at least three gaps of 100 ms.
    expect((at.at(-1) ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(280);
  });

  it('treats a rate limit as a reason to slow down, not a refusal', async () => {
    vi.stubGlobal('fetch', () =>
      answer({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32011, message: 'requests limited to 15/sec' },
      }),
    );
    expect(await client().send(1, '0x01')).toMatchObject({ retry: true, rateLimited: true });
    vi.stubGlobal('fetch', () => answer({ error: 'too many' }, 429));
    expect(await client().send(1, '0x01')).toMatchObject({ retry: true, rateLimited: true });
  });

  it('still refuses for good what the node rejects (and knows what it already has)', async () => {
    vi.stubGlobal('fetch', () =>
      answer({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'invalid sender' } }),
    );
    expect(await client().send(0, '0x01')).toMatchObject({ retry: false });
    vi.stubGlobal('fetch', () =>
      answer({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'already known' } }),
    );
    expect(await client().send(0, '0x01')).toBe('known');
  });
});

describe('reading a finalized block’s receipts (Slice 16)', () => {
  it('reads from whichever endpoint is free: one read per block', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return answer({ jsonrpc: '2.0', id: 1, result: [] });
    });
    expect(await client().blockReceipts(5)).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it('tries another endpoint at once when one has not seen the block yet', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return answer({ jsonrpc: '2.0', id: 1, result: asked.length === 1 ? null : [] });
    });
    expect(await client().blockReceipts(6)).toEqual([]);
    expect(asked).toHaveLength(2);
    expect(new Set(asked).size).toBe(2);
  });

  it('answers null only when no endpoint has the block', async () => {
    vi.stubGlobal('fetch', () => answer({ jsonrpc: '2.0', id: 1, result: null }));
    expect(await client().blockReceipts(7)).toBeNull();
  });
});
