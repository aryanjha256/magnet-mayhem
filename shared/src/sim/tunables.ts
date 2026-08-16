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

  { key: 'gravity', group: 'World', label: 'Gravity', kind: 'range', min: -60, max: 0, step: 1 },
];
