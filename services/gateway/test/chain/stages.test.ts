import { describe, expect, it } from 'vitest';
import { StageTracker } from '../../src/chain/stages.js';

// Captured from wss://testnet-rpc.monad.xyz on 7 Oct 2026 (monadNewHeads), trimmed; block IDs shortened.
const SAMPLE = [
  { at: 1791347032061, number: 68874549, blockId: '0x6f597f99bd', commitState: 'Finalized' },
  { at: 1791347032198, number: 68874550, blockId: '0x7f643b16d6', commitState: 'Voted' },
  { at: 1791347032204, number: 68874551, blockId: '0xec7cb558d6', commitState: 'Proposed' },
  { at: 1791347032465, number: 68874550, blockId: '0x7f643b16d6', commitState: 'Finalized' },
  { at: 1791347032470, number: 68874551, blockId: '0xec7cb558d6', commitState: 'Voted' },
  { at: 1791347032696, number: 68874551, blockId: '0xec7cb558d6', commitState: 'Finalized' },
  { at: 1791347032698, number: 68874548, blockId: '0x7c0b6e282c', commitState: 'Verified' },
];

describe('StageTracker', () => {
  it('records when the finalized block first reached each stage', () => {
    const t = new StageTracker();
    SAMPLE.forEach((s) => {
      t.observe(s.number, s.blockId, s.commitState, s.at);
    });
    expect(t.stagesOf(68874551)).toEqual({
      Proposed: 1791347032204,
      Voted: 1791347032470,
      Finalized: 1791347032696,
    });
  });

  it('keeps the first time if a stage is reported again', () => {
    const t = new StageTracker();
    t.observe(10, 'a', 'Finalized', 100);
    t.observe(10, 'a', 'Finalized', 200);
    expect(t.stagesOf(10)?.Finalized).toBe(100);
  });

  it('does not lend a replaced proposal’s times to the block that was finalized', () => {
    const t = new StageTracker();
    t.observe(10, 'first', 'Proposed', 1);
    t.observe(10, 'second', 'Proposed', 2);
    t.observe(10, 'second', 'Voted', 3);
    t.observe(10, 'second', 'Finalized', 4);
    expect(t.stagesOf(10)).toEqual({ Proposed: 2, Voted: 3, Finalized: 4 });
  });

  it('knows nothing about a block until it is Finalized', () => {
    const t = new StageTracker();
    t.observe(10, 'a', 'Voted', 1);
    expect(t.stagesOf(10)).toBeUndefined();
    t.observe(11, 'b', 'Verified', 2);
    expect(t.stagesOf(11)).toBeUndefined();
  });

  it('ignores stages it does not know', () => {
    const t = new StageTracker();
    t.observe(10, 'a', 'Wobbly', 1);
    t.observe(10, 'a', 'Finalized', 2);
    expect(t.stagesOf(10)).toEqual({ Finalized: 2 });
  });
});
