/**
 * Plain data shared by the simulation and whatever reads it (renderer today,
 * a network snapshot encoder later). Nothing in `sim/` may import a renderer.
 */

export type EntityId = number;

export type EntityKind = 'player' | 'dummy' | 'ball' | 'crate' | 'platform';

/** Render hint only — the sim uses the collider, not this. */
export type Shape =
  | { type: 'sphere'; radius: number }
  | { type: 'box'; hx: number; hy: number; hz: number };

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Entity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly shape: Shape;
  /** Magnets act on this body at all. Platforms are not magnetic. */
  readonly magnetic: boolean;
  /** Static bodies never move and are skipped by interpolation. */
  readonly static: boolean;
  /** Where this body returns to after falling into the void. */
  readonly spawn: Vec3;

  mass: number;

  /** Transform at the end of the current tick. */
  pos: Vec3;
  rot: Quat;
  /** Transform at the end of the previous tick, for render interpolation. */
  prevPos: Vec3;
  prevRot: Quat;

  /** Render hint like `shape`: 0 means "use the default for this kind". */
  tint: number;
}

/**
 * One magnet acting on one body during a tick.
 *
 * A per-entity scalar cannot express this any more: with several magnets in
 * the arena, a single body is routinely pulled by two of them at once, and the
 * renderer has to draw a tether per *pair* to keep the causality readable.
 */
export interface MagnetLink {
  sourceId: EntityId;
  targetId: EntityId;
  /** Newtons, signed: negative pulls the target toward the source. */
  force: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}
