export const STAGES = ['Proposed', 'Voted', 'Finalized', 'Verified'] as const;
export type Stage = (typeof STAGES)[number];
export type StageTimes = Partial<Record<Stage, number>>;

const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);

/**
 * Records when each block reached each stage, from monadNewHeads messages.
 * Times are kept per block ID, not per block number: a proposal can be replaced by
 * another at the same height, and only the one that is Finalized counts.
 */
export class StageTracker {
  private readonly byBlockId = new Map<string, StageTimes>();
  private readonly finalizedId = new Map<number, string>();

  observe(blockNumber: number, blockId: string, commitState: string, at: number): void {
    if (!isStage(commitState)) return;
    const times = this.byBlockId.get(blockId) ?? {};
    times[commitState] ??= at;
    this.byBlockId.set(blockId, times);
    if (commitState === 'Finalized' && !this.finalizedId.has(blockNumber))
      this.finalizedId.set(blockNumber, blockId);
  }

  /** The stage times of the block finalized at this height; undefined until it is Finalized. */
  stagesOf(blockNumber: number): StageTimes | undefined {
    const id = this.finalizedId.get(blockNumber);
    return id === undefined ? undefined : { ...this.byBlockId.get(id) };
  }
}
