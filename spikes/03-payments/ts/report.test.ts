import { describe, expect, it } from 'vitest';
import { summarise, type TxRecord } from './report.js';

const rec = (i: number, over: Partial<TxRecord> = {}): TxRecord => ({
  hash: `0x${String(i)}`,
  wallet: 'a',
  sentAt: 1_000 + i,
  block: 100 + Math.floor(i / 2),
  finalizedAt: 1_700 + i,
  gasLimit: 100_000n,
  gasUsed: 90_000n,
  status: 'success',
  ...over,
});

describe('summarise', () => {
  it('measures the run from first send to last finalized', () => {
    const s = summarise([rec(0), rec(1), rec(2), rec(3)], 102_000_000_000n);
    expect(s.wallClockMs).toBe(1_703 - 1_000);
    expect(s.count).toBe(4);
    expect(s.succeeded).toBe(4);
  });

  it('counts blocks used and transactions per block', () => {
    const s = summarise([rec(0), rec(1), rec(2), rec(3)], 102_000_000_000n);
    expect(s.blocksUsed).toBe(2);
    expect(s.maxPerBlock).toBe(2);
  });

  it('charges MON on the gas limit, as Monad does', () => {
    const s = summarise([rec(0), rec(1)], 102_000_000_000n);
    expect(s.monSpent).toBeCloseTo(2 * 100_000 * 102e-9, 10);
    expect(s.gasUsedPerTx).toBe(90_000);
  });

  it('charges nothing for a transaction that never landed', () => {
    const s = summarise(
      [rec(0), rec(1, { status: 'missing', block: undefined, finalizedAt: undefined })],
      102_000_000_000n,
    );
    expect(s.monSpent).toBeCloseTo(100_000 * 102e-9, 10);
  });

  it('gives send-to-finalized percentiles', () => {
    const s = summarise(
      Array.from({ length: 100 }, (_, i) => rec(i, { sentAt: 0, finalizedAt: i + 1 })),
      1n,
    );
    expect(s.p50Ms).toBe(50);
    expect(s.p95Ms).toBe(95);
  });

  it('counts reverted and missing transactions separately, never as successes', () => {
    const s = summarise(
      [
        rec(0),
        rec(1, { status: 'reverted' }),
        rec(2, { status: 'missing', block: undefined, finalizedAt: undefined }),
      ],
      1n,
    );
    expect([s.succeeded, s.reverted, s.missing]).toEqual([1, 1, 1]);
  });

  it('measures how long sending took, separately from settling', () => {
    const s = summarise([rec(0, { acceptedAt: 1_050 }), rec(3, { acceptedAt: 1_400 })], 1n);
    expect(s.sendWindowMs).toBe(1_400 - 1_000);
  });

  it('reports gas for successes and refusals separately', () => {
    const s = summarise(
      [
        rec(0, { gasUsed: 90_000n }),
        rec(1, { status: 'reverted', gasUsed: 30_000n }),
        rec(2, { status: 'reverted', gasUsed: 32_000n }),
      ],
      1n,
    );
    expect(s.gasUsedPerTx).toBe(90_000);
    expect(s.gasUsedPerRevert).toBe(31_000);
  });
});
