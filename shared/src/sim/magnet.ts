/**
 * The magnet force curve. Pure functions, no engine types — this is the single
 * number the whole game's feel hangs off, so it lives on its own and is
 * trivially testable.
 *
 * The force is always applied SYMMETRICALLY: +F on the target, -F on the
 * magnet. That is Newton's third law, and it is what makes one mechanic cover
 * both "throw the ball at someone" and "grapple yourself across the arena" —
 * acceleration is F/m, so the mass ratio decides who actually moves.
 *
 *   light ball  -> the ball flies at you
 *   giant crate -> you fly at the crate
 */

export type FalloffMode = 'linear' | 'smooth' | 'inverseSquare';

export const FALLOFF_MODES: readonly FalloffMode[] = ['linear', 'smooth', 'inverseSquare'];

/**
 * Normalized force multiplier in [0, 1] for a body `distance` away.
 *
 * All modes reach exactly 0 at `range` so objects never pop when they cross
 * the boundary, and all are clamped near the origin so nothing explodes.
 *
 * `inverseSquare` is included mostly so you can feel why it is a bad default:
 * it is near-dead at mid range and overwhelming up close, which reads as
 * "broken" rather than "skillful". `smooth` is the one worth tuning.
 */
export function falloff(
  mode: FalloffMode,
  distance: number,
  range: number,
  exponent: number,
  minDistance: number,
): number {
  if (range <= 0) return 0;
  const t = clamp01(distance / range);
  const window = 1 - t;
  if (window <= 0) return 0;

  switch (mode) {
    case 'linear':
      return window;
    case 'smooth':
      return Math.pow(window, Math.max(exponent, 0.01));
    case 'inverseSquare': {
      // Clamped so d -> 0 cannot send the force to infinity, and windowed so
      // it still decays to zero at max range instead of cutting off abruptly.
      const d = Math.max(distance, minDistance);
      return ((minDistance * minDistance) / (d * d)) * window;
    }
  }
}

/**
 * Is `dir` inside the magnet cone pointing along `aim`? Both are XZ-plane
 * vectors; `dir` need not be normalized.
 *
 * A body directly above or below the magnet has a degenerate XZ direction and
 * counts as inside the cone.
 */
export function inCone(
  dirX: number,
  dirZ: number,
  aimX: number,
  aimZ: number,
  cosHalfAngle: number,
): boolean {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-4) return true;
  return (dirX * aimX + dirZ * aimZ) / len >= cosHalfAngle;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
