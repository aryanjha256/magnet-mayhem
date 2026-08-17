import type { EntityId } from './types';

/**
 * Round structure.
 *
 * Everything before this was a sandbox: falling off cost nothing, so no shove
 * ever mattered. Elimination is what gives the magnet stakes.
 */
export type MatchPhase = 'countdown' | 'playing' | 'roundOver' | 'matchOver';

/** Wire-friendly ordering; the protocol sends the index, not the string. */
export const MATCH_PHASES: readonly MatchPhase[] = [
  'countdown',
  'playing',
  'roundOver',
  'matchOver',
];

export interface MatchState {
  phase: MatchPhase;
  /** Ticks left in this phase. During `playing` this is the round clock. */
  timer: number;
  /** 1-based round number within the current match. */
  round: number;
  /** Ticks spent in the current round, for the shrink curve. */
  elapsed: number;
  /** Winner of the round that just ended, or 0 for a draw / not yet decided. */
  lastWinner: EntityId;
  /** Winner of the match, or 0 while it is still running. */
  champion: EntityId;
  /** Current platform radius, shrinking during `playing`. */
  arenaRadius: number;
  /**
   * How many players were alive when the round began. A round cannot be won by
   * default when there was only ever one player, which is what keeps the
   * single-player tuning sandbox usable.
   */
  startedWith: number;
}
