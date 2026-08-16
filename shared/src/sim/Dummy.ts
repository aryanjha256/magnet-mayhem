import { TUNABLES } from './tunables';
import type { Vec3 } from './types';

/**
 * Stand-in opponents, so the one untested claim in the design — that players
 * are magnetic to each other — can be felt before any networking exists.
 *
 * These are not AI. They are three fixed answers to three separate questions:
 *
 *   inert    can I fling another player off the edge at all?
 *   grabber  what does it feel like when something pulls back?
 *   opposer  does opposing polarity actually produce a tug-of-war, or mush?
 *
 * Deliberately pure functions of (self, target, what the player is doing), so
 * they run headlessly and stay deterministic.
 */
export type DummyBehavior = 'inert' | 'grabber' | 'opposer';

export interface DummyCommand {
  aimX: number;
  aimZ: number;
  /** Signed magnet throttle, same convention as Input.magnet. */
  magnet: number;
}

const IDLE: DummyCommand = { aimX: 0, aimZ: 1, magnet: 0 };

/** A grabber stops reeling once it has you, so it cannot weld itself on. */
const GRAB_RELEASE_DISTANCE = 3;
/** Ticks of pull, then ticks of rest. Gives you a window to escape. */
const GRAB_ON_TICKS = 40;
const GRAB_CYCLE_TICKS = 95;

export function decideDummy(
  behavior: DummyBehavior,
  tick: number,
  self: Vec3,
  player: Vec3,
  playerMagnet: number,
): DummyCommand {
  if (behavior === 'inert') return IDLE;

  const dx = player.x - self.x;
  const dz = player.z - self.z;
  const distance = Math.hypot(dx, dz);
  // Out of range it would apply no force anyway; bail early so the renderer
  // does not draw a tether that does nothing.
  if (distance < 1e-4 || distance > TUNABLES.magnetRange) return IDLE;

  const aimX = dx / distance;
  const aimZ = dz / distance;

  if (behavior === 'grabber') {
    // Pulsed, and it lets go once you are close. A constant pull just glues
    // the two of you together at contact range, which is neither fun nor
    // informative. Driven off `tick` rather than a timer so it stays
    // deterministic.
    if (distance < GRAB_RELEASE_DISTANCE) return IDLE;
    if (tick % GRAB_CYCLE_TICKS >= GRAB_ON_TICKS) return IDLE;
    // It drags *itself* toward you just as hard, because the force is
    // symmetric — no movement code needed to make it close the distance.
    return { aimX, aimZ, magnet: -1 };
  }

  // opposer: mirror the player's polarity inverted, at matching strength.
  // Equal and opposite forces on both bodies cancel exactly, so a polarity
  // conflict is a genuine stalemate rather than a slow win for someone.
  return { aimX, aimZ, magnet: -playerMagnet };
}
