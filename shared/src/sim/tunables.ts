import { FALLOFF_MODES, type FalloffMode } from './magnet';

/**
 * Every number worth arguing about, in one mutable object the debug panel
 * writes to live. The sim reads these each tick, so nothing needs restarting.
 *
 * These values are the *optimistic* feel: they are tuned against a zero-latency
 * local sim. Expect to revisit them once objects arrive over a network.
 */
export interface Tunables {
  // --- magnet ---
  magnetRange: number;
  magnetStrength: number;
  falloffMode: FalloffMode;
  /** Only affects `smooth`. 1 == linear, higher == more concentrated up close. */
  falloffExponent: number;
  /** Distance floor, in metres. Stops the force blowing up at contact range. */
  minDistance: number;
  /** Half-angle of the magnet cone in degrees. 180 == fully radial. */
  coneHalfAngleDeg: number;
  /** Scales the equal-and-opposite force felt by the player. 1 == true physics. */
  reactionScale: number;

  // --- movement ---
  moveForce: number;
  maxSpeed: number;
  linearDamping: number;
  dashImpulse: number;
  dashCooldownTicks: number;

  // --- bots ---
  /** Ticks a bot holds a decision. Higher = slower reactions, easier to juke. */
  botReactionTicks: number;
  /** Peak aim error in degrees. This is how a bot misses. */
  botAimErrorDeg: number;
  /** Scales bot magnet throttle. Below 1 they shove softer than you do. */
  botMagnetScale: number;
  /**
   * How early a bot bails out toward the middle. 1 is the paranoid original,
   * which made them essentially unkillable; lower means they overcommit and
   * can actually be rung out.
   */
  botCaution: number;

  // --- match ---
  /** Hard cap on a round. The shrink should usually end it sooner. */
  roundSeconds: number;
  /** Round wins needed to take the match. */
  roundsToWin: number;
  /** Grace period before the platform starts closing in. */
  shrinkGraceSeconds: number;
  /** Seconds from the end of the grace period to the smallest arena. */
  shrinkSeconds: number;
  /** Radius the platform closes down to. */
  arenaMinRadius: number;

  // --- world ---
  gravity: number;
  /** Fall below this and you respawn. */
  killY: number;
}

export const TUNABLES: Tunables = {
  magnetRange: 12,
  magnetStrength: 450,
  falloffMode: 'smooth',
  falloffExponent: 2,
  minDistance: 1,
  coneHalfAngleDeg: 70,
  reactionScale: 1,

  moveForce: 90,
  maxSpeed: 9,
  linearDamping: 0.5,
  dashImpulse: 26,
  dashCooldownTicks: 40,

  // Tuned so a bot is beatable, not so it is fair. Three of them against one
  // human is already a 3v1; frame-perfect reactions on top of that made the
  // first build unwinnable.
  botReactionTicks: 9,
  botAimErrorDeg: 13,
  botMagnetScale: 0.75,
  botCaution: 0.62,

  roundSeconds: 75,
  roundsToWin: 3,
  shrinkGraceSeconds: 15,
  shrinkSeconds: 45,
  arenaMinRadius: 3,

  gravity: -26,
  killY: -25,
};

export type TunableKey = keyof Tunables;

export type TunableSpec =
  | { key: TunableKey; group: string; label: string; kind: 'range'; min: number; max: number; step: number }
  | { key: TunableKey; group: string; label: string; kind: 'select'; options: readonly string[] };

export const TUNABLE_SPECS: readonly TunableSpec[] = [
  { key: 'magnetStrength', group: 'Magnet', label: 'Strength', kind: 'range', min: 0, max: 1200, step: 10 },
  { key: 'magnetRange', group: 'Magnet', label: 'Range', kind: 'range', min: 2, max: 30, step: 0.5 },
  { key: 'falloffMode', group: 'Magnet', label: 'Falloff', kind: 'select', options: FALLOFF_MODES },
  { key: 'falloffExponent', group: 'Magnet', label: 'Exponent', kind: 'range', min: 0.5, max: 5, step: 0.1 },
  { key: 'minDistance', group: 'Magnet', label: 'Min distance', kind: 'range', min: 0.2, max: 4, step: 0.1 },
  { key: 'coneHalfAngleDeg', group: 'Magnet', label: 'Cone half-angle', kind: 'range', min: 10, max: 180, step: 5 },
  { key: 'reactionScale', group: 'Magnet', label: 'Reaction on self', kind: 'range', min: 0, max: 3, step: 0.05 },

  { key: 'moveForce', group: 'Movement', label: 'Move force', kind: 'range', min: 0, max: 200, step: 5 },
  { key: 'maxSpeed', group: 'Movement', label: 'Max speed', kind: 'range', min: 1, max: 25, step: 0.5 },
  { key: 'linearDamping', group: 'Movement', label: 'Damping', kind: 'range', min: 0, max: 3, step: 0.05 },
  { key: 'dashImpulse', group: 'Movement', label: 'Dash impulse', kind: 'range', min: 0, max: 80, step: 1 },
  { key: 'dashCooldownTicks', group: 'Movement', label: 'Dash cooldown (ticks)', kind: 'range', min: 0, max: 180, step: 5 },

  { key: 'botReactionTicks', group: 'Bots', label: 'Reaction (ticks)', kind: 'range', min: 1, max: 30, step: 1 },
  { key: 'botAimErrorDeg', group: 'Bots', label: 'Aim error', kind: 'range', min: 0, max: 40, step: 1 },
  { key: 'botMagnetScale', group: 'Bots', label: 'Magnet power', kind: 'range', min: 0, max: 1.5, step: 0.05 },
  { key: 'botCaution', group: 'Bots', label: 'Self-preservation', kind: 'range', min: 0.2, max: 1.2, step: 0.02 },

  { key: 'roundSeconds', group: 'Match', label: 'Round cap (s)', kind: 'range', min: 15, max: 180, step: 5 },
  { key: 'roundsToWin', group: 'Match', label: 'Rounds to win', kind: 'range', min: 1, max: 9, step: 1 },
  { key: 'shrinkGraceSeconds', group: 'Match', label: 'Shrink delay (s)', kind: 'range', min: 0, max: 60, step: 1 },
  { key: 'shrinkSeconds', group: 'Match', label: 'Shrink duration (s)', kind: 'range', min: 5, max: 120, step: 5 },
  { key: 'arenaMinRadius', group: 'Match', label: 'Final radius', kind: 'range', min: 1.5, max: 8, step: 0.25 },

  { key: 'gravity', group: 'World', label: 'Gravity', kind: 'range', min: -60, max: 0, step: 1 },
];
