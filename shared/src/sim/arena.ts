import type { DummyBehavior } from './Dummy';
import type { EntityKind, Shape, Vec3 } from './types';

/**
 * The arena as data rather than code, so it can be sent by a server later
 * instead of being baked into the client.
 */
export interface BodySpec {
  kind: EntityKind;
  shape: Shape;
  /** Ignored for static bodies. */
  mass: number;
  spawn: Vec3;
  magnetic: boolean;
  static: boolean;
  friction: number;
  restitution: number;
  /** Keeps player-shaped bodies upright instead of rolling. */
  lockRotations: boolean;
  /** Render hint; 0 uses the default colour for the kind. */
  tint: number;
}

export const PLAYER_SPAWN: Vec3 = { x: 0, y: 2, z: 0 };
export const PLAYER_RADIUS = 0.55;
export const PLAYER_MASS = 5;

/** Half-extents of the floating platform. Its top surface sits at y = 0. */
export const PLATFORM_HALF = { x: 9, y: 0.4, z: 9 };

function ball(x: number, z: number, radius: number, mass: number): BodySpec {
  return {
    kind: 'ball',
    shape: { type: 'sphere', radius },
    mass,
    spawn: { x, y: radius + 0.5, z },
    magnetic: true,
    static: false,
    friction: 0.25,
    restitution: 0.45,
    lockRotations: false,
    tint: 0,
  };
}

function crate(x: number, z: number, half: number, mass: number): BodySpec {
  return {
    kind: 'crate',
    shape: { type: 'box', hx: half, hy: half, hz: half },
    mass,
    spawn: { x, y: half + 0.5, z },
    magnetic: true,
    static: false,
    friction: 0.7,
    restitution: 0.1,
    lockRotations: false,
    tint: 0,
  };
}

/** Player-shaped body: same mass, grip and upright constraint as you. */
export interface DummySpec extends BodySpec {
  behavior: DummyBehavior;
}

function dummy(x: number, z: number, behavior: DummyBehavior, tint: number): DummySpec {
  return {
    kind: 'dummy',
    shape: { type: 'sphere', radius: PLAYER_RADIUS },
    mass: PLAYER_MASS,
    spawn: { x, y: PLAYER_RADIUS + 1, z },
    magnetic: true,
    static: false,
    friction: 0.2,
    restitution: 0.1,
    lockRotations: true,
    tint,
    behavior,
  };
}

/**
 * Three opponents, three questions. Positions are kept clear of the ±Z test
 * lanes so the narrow-cone smoke checks still isolate a single body.
 */
export const ARENA_DUMMIES: readonly DummySpec[] = [
  dummy(-5, 2, 'inert', 0x8f9bb3),
  dummy(5, 2, 'grabber', 0xc678dd),
  dummy(-3, -3.5, 'opposer', 0x56c98a),
];

export const ARENA_BODIES: readonly BodySpec[] = [
  // Platform. No walls — falling off is the entire point.
  {
    kind: 'platform',
    shape: { type: 'box', hx: PLATFORM_HALF.x, hy: PLATFORM_HALF.y, hz: PLATFORM_HALF.z },
    mass: 0,
    spawn: { x: 0, y: -PLATFORM_HALF.y, z: 0 },
    magnetic: false,
    static: true,
    friction: 0.8,
    restitution: 0,
    lockRotations: false,
    tint: 0,
  },

  // Light: one flick sends these flying. Mass ratio means the ball moves, not you.
  // The -Z lane is deliberately clear apart from this one, so a narrow cone
  // aimed at it isolates a single body (see scripts/smoke.ts).
  ball(0, -6, 0.4, 1.2),
  ball(-4, -4, 0.4, 1.2),
  ball(4, -4, 0.4, 1.2),
  ball(-4, 4, 0.4, 1.2),
  ball(4, 4, 0.4, 1.2),
  ball(-7, 1.5, 0.4, 1.2),

  // Heavy: shoves you around noticeably while you shove it.
  ball(-6.5, -1.5, 0.8, 14),
  ball(6.5, -1.5, 0.8, 14),
  ball(6.5, 4.5, 1.0, 26),

  // Giant: effectively an anchor. Attracting this is how you grapple.
  // The +Z lane is likewise kept clear for this one.
  crate(0, 6, 1.3, 70),
  crate(-6, 6.5, 1.3, 70),
];
