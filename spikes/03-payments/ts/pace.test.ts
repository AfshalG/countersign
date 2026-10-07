import { describe, expect, it } from 'vitest';
import { Pacer } from './pace.js';

describe('Pacer', () => {
  it('spaces requests to one endpoint by its rate', () => {
    const p = new Pacer([10]);
    expect([p.take(0), p.take(0), p.take(0)].map((s) => s.at)).toEqual([0, 100, 200]);
  });

  it('sends each request to the endpoint that is free soonest', () => {
    const p = new Pacer([50, 25]); // one slot every 20 ms and every 40 ms
    const picks = Array.from({ length: 5 }, () => p.take(0));
    expect(picks).toEqual([
      { index: 0, at: 0 },
      { index: 1, at: 0 },
      { index: 0, at: 20 },
      { index: 0, at: 40 },
      { index: 1, at: 40 },
    ]);
  });

  it('never schedules in the past', () => {
    const p = new Pacer([10]);
    p.take(0);
    expect(p.take(5_000).at).toBe(5_000);
  });

  it('refuses a rate that is not positive', () => {
    expect(() => new Pacer([10, 0])).toThrow(/rate/);
  });
});
