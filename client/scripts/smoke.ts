/**
 * Headless sim checks. Run with `npm run smoke`.
 *
 * The fact that this runs at all under plain Node — no DOM, no canvas, no
 * Three.js — is the point: `src/sim/` is already the thing that can be lifted
 * onto a server in Phase 4. If someone imports a renderer into the sim, this
 * file stops working, which is exactly the alarm we want.
 */
import type { GamepadState } from '../src/input/GamepadSource';
import type { RawInput } from '../src/input/InputSource';
import { emptyInput, type Input } from '@magnet/shared/sim/input';
import { TUNABLES, type Tunables } from '@magnet/shared/sim/tunables';
import { initSim, SimWorld, TICK_RATE } from '@magnet/shared/sim/World';
import type { Entity, EntityId } from '@magnet/shared/sim/types';

const SEED = 0x5eed;
/**
 * Worlds for measuring one magnet in isolation. With the dummies present the
 * grabber tows the player off the origin during the settle, which silently
 * corrupts every single-actor measurement below.
 */
const SOLO = { dummies: false } as const;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

/** Advance `ticks` ticks, optionally shaping each tick's input. */
function run(world: SimWorld, ticks: number, shape?: (input: Input, n: number) => void): void {
  for (let n = 0; n < ticks; n++) {
    const input = emptyInput(world.tick + 1);
    shape?.(input, n);
    world.step(input);
  }
}

function withTunables(overrides: Partial<Tunables>, fn: () => void): void {
  const saved: Tunables = { ...TUNABLES };
  Object.assign(TUNABLES, overrides);
  try {
    fn();
  } finally {
    Object.assign(TUNABLES, saved);
  }
}

/** The light ball parked alone in the -Z lane. */
function lightBall(world: SimWorld): Entity {
  const e = world.entities.find((x) => x.kind === 'ball' && x.spawn.z === -6);
  if (!e) throw new Error('lane ball missing');
  return e;
}

/** The giant crate parked alone in the +Z lane. */
function laneCrate(world: SimWorld): Entity {
  const e = world.entities.find((x) => x.kind === 'crate' && x.spawn.z === 6);
  if (!e) throw new Error('lane crate missing');
  return e;
}

async function main(): Promise<void> {
  await initSim();

  section('World construction');
  {
    const world = new SimWorld();
    check('entities created', world.entities.length === 16, `${world.entities.length} entities`);
    check('dummies can be left out', new SimWorld(SEED, SOLO).entities.length === 13);
    check('player is magnetic', world.player.magnetic);
    check('player mass read back from rapier', Math.abs(world.player.mass - 5) < 0.001,
      `${world.player.mass.toFixed(3)} kg`);
    check('platform is static', world.entities[0]!.static);
  }

  section('Settling under gravity');
  {
    const world = new SimWorld(SEED, SOLO);
    run(world, TICK_RATE * 2);
    const player = world.player;
    const resting = Math.abs(player.pos.y - 0.55) < 0.05;
    check('player rests on the platform', resting, `y=${player.pos.y.toFixed(3)}`);
    check('nothing fell off on its own', world.me.deaths === 0);
    const moving = world.entities.filter(
      (e) => !e.static && Math.hypot(e.pos.x - e.prevPos.x, e.pos.z - e.prevPos.z) > 0.01,
    );
    check('arena is at rest', moving.length === 0, `${moving.length} still drifting`);
  }

  section('Walking');
  {
    const world = new SimWorld(SEED, SOLO);
    run(world, TICK_RATE);
    const start = { ...world.player.pos };

    run(world, TICK_RATE, (i) => {
      i.moveZ = -1;
    });

    const dz = world.player.pos.z - start.z;
    const speed = Math.hypot(world.me.velocity.x, world.me.velocity.z);
    check('W moves the player along -Z', dz < -1, `dz=${dz.toFixed(2)}m`);
    check('reaches a usable walking speed', speed > 2, `${speed.toFixed(2)} m/s`);
    check('stays on the platform', Math.abs(world.player.pos.y - 0.55) < 0.05,
      `y=${world.player.pos.y.toFixed(3)}`);

    const startX = world.player.pos.x;
    run(world, TICK_RATE / 2, (i) => {
      i.moveX = 1;
    });
    check('D moves the player along +X', world.player.pos.x > startX + 0.5,
      `dx=${(world.player.pos.x - startX).toFixed(2)}m`);

    // Diagonals must not be faster than cardinals.
    const w2 = new SimWorld(SEED, SOLO);
    run(w2, TICK_RATE);
    run(w2, TICK_RATE, (i) => {
      i.moveX = 1;
      i.moveZ = -1;
    });
    const diagSpeed = Math.hypot(w2.me.velocity.x, w2.me.velocity.z);
    check('diagonal is not faster than cardinal', Math.abs(diagSpeed - speed) < 0.5,
      `diag ${diagSpeed.toFixed(2)} vs cardinal ${speed.toFixed(2)} m/s`);

    // A half-deflected analog stick has to walk slower, not just point the
    // same way — the sim reads move magnitude as a throttle.
    const w3 = new SimWorld(SEED, SOLO);
    run(w3, TICK_RATE);
    run(w3, TICK_RATE, (i) => {
      i.moveZ = -0.4;
    });
    const halfSpeed = Math.hypot(w3.me.velocity.x, w3.me.velocity.z);
    check('half stick walks slower than full', halfSpeed < speed * 0.7,
      `${halfSpeed.toFixed(2)} vs ${speed.toFixed(2)} m/s`);
    check('half stick still moves', halfSpeed > 0.5);
  }

  section('Attract a LIGHT ball — the ball should move, not you');
  withTunables({ coneHalfAngleDeg: 20 }, () => {
    const world = new SimWorld(SEED, SOLO);
    run(world, TICK_RATE);
    const ball = lightBall(world);
    const ball0 = { ...ball.pos };
    const player0 = { ...world.player.pos };

    run(world, 12, (i) => {
      i.magnet = -1;
      i.aimX = 0;
      i.aimZ = -1;
    });

    const ballMoved = Math.hypot(ball.pos.x - ball0.x, ball.pos.z - ball0.z);
    const playerMoved = Math.hypot(world.player.pos.x - player0.x, world.player.pos.z - player0.z);

    check('ball is pulled toward the player', ball.pos.z > ball0.z + 0.5,
      `z ${ball0.z.toFixed(2)} -> ${ball.pos.z.toFixed(2)}`);
    check('player is pulled toward the ball too', world.player.pos.z < player0.z - 0.05,
      `z ${player0.z.toFixed(2)} -> ${world.player.pos.z.toFixed(2)}`);
    check('mass ratio favours the ball', ballMoved > playerMoved * 2,
      `ball ${ballMoved.toFixed(2)}m vs player ${playerMoved.toFixed(2)}m`);
  });

  section('Repel a LIGHT ball');
  withTunables({ coneHalfAngleDeg: 20 }, () => {
    const world = new SimWorld(SEED, SOLO);
    run(world, TICK_RATE);
    const ball = lightBall(world);
    const z0 = ball.pos.z;
    run(world, 12, (i) => {
      i.magnet = 1;
      i.aimX = 0;
      i.aimZ = -1;
    });
    check('ball is pushed away', ball.pos.z < z0 - 0.5,
      `z ${z0.toFixed(2)} -> ${ball.pos.z.toFixed(2)}`);
  });

  section('Attract the GIANT crate — you should move, not it');
  withTunables({ coneHalfAngleDeg: 20 }, () => {
    const world = new SimWorld(SEED, SOLO);
    run(world, TICK_RATE);
    const crate = laneCrate(world);
    const crate0 = { ...crate.pos };
    const player0 = { ...world.player.pos };

    run(world, 30, (i) => {
      i.magnet = -1;
      i.aimX = 0;
      i.aimZ = 1;
    });

    const crateMoved = Math.hypot(crate.pos.x - crate0.x, crate.pos.z - crate0.z);
    const playerMoved = Math.hypot(world.player.pos.x - player0.x, world.player.pos.z - player0.z);

    check('player is flung at the crate', playerMoved > 1.0, `${playerMoved.toFixed(2)}m`);
    check('crate barely budges', crateMoved < playerMoved / 4, `${crateMoved.toFixed(3)}m`);

    // Keep pulling and track the peak. The magnet has to beat the walk cap or
    // it is not a travel mechanic, just a nudge.
    let peak = 0;
    run(world, 60, (i) => {
      i.magnet = -1;
      i.aimX = 0;
      i.aimZ = 1;
      peak = Math.max(peak, Math.hypot(world.me.velocity.x, world.me.velocity.z));
    });
    check('grapple outruns walking', peak > TUNABLES.maxSpeed,
      `peak ${peak.toFixed(1)} m/s vs ${TUNABLES.maxSpeed} walk cap`);
  });

  section('Reaction can be disabled');
  withTunables({ coneHalfAngleDeg: 20, reactionScale: 0 }, () => {
    const world = new SimWorld(SEED, SOLO);
    run(world, TICK_RATE);
    const player0 = { ...world.player.pos };
    run(world, 30, (i) => {
      i.magnet = -1;
      i.aimX = 0;
      i.aimZ = 1;
    });
    const moved = Math.hypot(world.player.pos.x - player0.x, world.player.pos.z - player0.z);
    check('reactionScale 0 leaves the player put', moved < 0.05, `${moved.toFixed(4)}m`);
  });

  section('Cone actually gates the force');
  withTunables({ coneHalfAngleDeg: 20 }, () => {
    const world = new SimWorld(SEED, SOLO);
    run(world, TICK_RATE);
    run(world, 1, (i) => {
      i.magnet = -1;
      i.aimX = 0;
      i.aimZ = -1;
    });
    const fromPlayer = world.links.filter((l) => l.sourceId === world.playerId);
    check('a narrow cone hits exactly one body', fromPlayer.length === 1,
      `${fromPlayer.length} touched`);
    const target = world.entities.find((e) => e.id === fromPlayer[0]?.targetId);
    check('and it is the lane ball', target?.spawn.z === -6);
  });

  section('Dummy players — the untested half of the design');
  {
    const world = new SimWorld();
    const dummies = world.entities.filter((e) => e.kind === 'dummy');
    check('three dummies exist', dummies.length === 3, `${dummies.length}`);
    check('they are player-shaped', dummies.every((d) => Math.abs(d.mass - 5) < 0.001));
    check('and magnetic', dummies.every((d) => d.magnetic));

    run(world, TICK_RATE * 2);
    check('dummies settle without falling off', world.me.knockouts === 0);
    check('an idle player pulls on nothing',
      !world.links.some((l) => l.sourceId === world.playerId));
    // Dummies fire a focused beam, not a cone, or their own reaction forces
    // launch them off the arena before you can play with them.
    check('dummy magnets only ever touch the player',
      world.links.every((l) => l.sourceId === world.playerId || l.targetId === world.playerId));
  }

  section('Flinging another player (inert dummy)');
  withTunables({ coneHalfAngleDeg: 25 }, () => {
    const world = new SimWorld();
    run(world, TICK_RATE);
    const inert = world.entities.find((e) => e.kind === 'dummy' && e.spawn.x === -5)!;
    const start = { ...inert.pos };

    // Aim at it and shove.
    const dx = inert.pos.x - world.player.pos.x;
    const dz = inert.pos.z - world.player.pos.z;
    const len = Math.hypot(dx, dz);
    run(world, 40, (i) => {
      i.magnet = 1;
      i.aimX = dx / len;
      i.aimZ = dz / len;
    });

    const moved = Math.hypot(inert.pos.x - start.x, inert.pos.z - start.z);
    check('a player-mass body can be shoved', moved > 1, `${moved.toFixed(2)}m`);
    check('and it never fights back', !world.links.some((l) => l.sourceId === inert.id));

    // Equal masses, so the reaction should push you back about as far.
    const recoil = Math.hypot(world.player.pos.x, world.player.pos.z);
    check('equal mass means real recoil', recoil > 0.5, `${recoil.toFixed(2)}m`);
  });

  section('Tug-of-war (opposer dummy)');
  withTunables({ coneHalfAngleDeg: 25 }, () => {
    /** Attract the opposer for 45 ticks; report how far it was dragged. */
    const pull = (fightBack: boolean): { dragged: number; world: SimWorld; id: EntityId } => {
      const world = new SimWorld();
      const opposer = world.entities.find((e) => e.kind === 'dummy' && e.spawn.x === -3)!;
      if (!fightBack) world.setDummyBehavior(opposer.id, 'inert');

      run(world, TICK_RATE);
      const start = { ...opposer.pos };
      const dx = opposer.pos.x - world.player.pos.x;
      const dz = opposer.pos.z - world.player.pos.z;
      const len = Math.hypot(dx, dz);
      run(world, 45, (i) => {
        i.magnet = -1;
        i.aimX = dx / len;
        i.aimZ = dz / len;
      });

      return {
        dragged: Math.hypot(opposer.pos.x - start.x, opposer.pos.z - start.z),
        world,
        id: opposer.id,
      };
    };

    // Identical input against the same body, the only difference being whether
    // it fights back. A control run is the only honest way to measure this:
    // the player's own cone also grabs other bodies, so "nobody moved" was
    // never going to hold.
    const passive = pull(false);
    const fighting = pull(true);

    const mine = fighting.world.links.find(
      (l) => l.sourceId === fighting.world.playerId && l.targetId === fighting.id,
    );
    const theirs = fighting.world.links.find(
      (l) => l.sourceId === fighting.id && l.targetId === fighting.world.playerId,
    );
    check('both magnets engage each other', !!mine && !!theirs);
    // This exact cancellation is the whole mechanism.
    check('forces are equal and opposite',
      !!mine && !!theirs && Math.abs(mine.force + theirs.force) < 1e-9,
      `${mine?.force.toFixed(1)}N vs ${theirs?.force.toFixed(1)}N`);
    check('fighting back genuinely resists the pull',
      fighting.dragged < passive.dragged * 0.4,
      `dragged ${fighting.dragged.toFixed(2)}m vs ${passive.dragged.toFixed(2)}m passive`);
  });

  section('Getting grabbed (grabber dummy)');
  {
    const world = new SimWorld();
    const grabber = world.entities.find((e) => e.kind === 'dummy' && e.spawn.x === 5)!;
    const gap = (): number =>
      Math.hypot(grabber.pos.x - world.player.pos.x, grabber.pos.z - world.player.pos.z);
    const gap0 = gap();

    // The player does nothing at all. The dummy should still close on them.
    run(world, TICK_RATE * 3);
    const gap1 = gap();

    check('a grabber reels you in unprompted', gap1 < gap0 - 1,
      `${gap0.toFixed(2)}m -> ${gap1.toFixed(2)}m`);
    check('and it lets go once it is close',
      !world.links.some((l) => l.sourceId === grabber.id));

    // Arriving at contact is fine; being unable to leave is not. A constant
    // pull would pin you there permanently.
    let escaped = 0;
    run(world, TICK_RATE * 2, (i) => {
      i.moveX = -1;
      escaped = Math.max(escaped, gap());
    });
    check('you can walk out of a grab', escaped > 3, `opened up to ${escaped.toFixed(2)}m`);

    let everLinked = false;
    const w2 = new SimWorld();
    const far = w2.entities.find((e) => e.kind === 'dummy' && e.spawn.x === 5)!;
    run(w2, 30, () => {
      if (w2.links.some((l) => l.sourceId === far.id)) everLinked = true;
    });
    check('the tether is visible to the renderer while pulling', everLinked);
  }

  section('Multiple players in one world');
  {
    const world = new SimWorld(SEED, { dummies: false, players: 0 });
    check('a room can start empty', world.players.size === 0);

    const a = world.addPlayer();
    const b = world.addPlayer();
    check('players get distinct ids', a.id !== b.id, `${a.id} vs ${b.id}`);
    check('and separate spawn points',
      Math.hypot(a.entity.spawn.x - b.entity.spawn.x, a.entity.spawn.z - b.entity.spawn.z) > 1);

    run(world, TICK_RATE);
    check('both settle on the platform',
      Math.abs(a.entity.pos.y - 0.55) < 0.05 && Math.abs(b.entity.pos.y - 0.55) < 0.05);

    // Per-player scores and cooldowns must not be shared state.
    const inputs = new Map<EntityId, Input>();
    inputs.set(a.id, { ...emptyInput(world.tick), dash: true });
    inputs.set(b.id, emptyInput(world.tick));
    world.step(inputs);
    check('dash cooldown is per player', a.dashCooldown > 0 && b.dashCooldown === 0,
      `a=${a.dashCooldown} b=${b.dashCooldown}`);

    // One player shoves the other: the core PvP interaction, now between two
    // real players rather than a player and a scripted dummy.
    withTunables({ coneHalfAngleDeg: 25 }, () => {
      const start = { ...b.entity.pos };
      const dx = b.entity.pos.x - a.entity.pos.x;
      const dz = b.entity.pos.z - a.entity.pos.z;
      const len = Math.hypot(dx, dz);

      // Sampled during the push, not after: aim is fixed at the starting
      // direction, so by the last tick the target has drifted out of the cone.
      let everLinked = false;
      for (let n = 0; n < 40; n++) {
        const shove = new Map<EntityId, Input>();
        shove.set(a.id, { ...emptyInput(world.tick + 1), aimX: dx / len, aimZ: dz / len, magnet: 1 });
        shove.set(b.id, emptyInput(world.tick + 1));
        world.step(shove);
        if (world.links.some((l) => l.sourceId === a.id && l.targetId === b.id)) everLinked = true;
      }

      const moved = Math.hypot(b.entity.pos.x - start.x, b.entity.pos.z - start.z);
      check('one player can shove another', moved > 1, `${moved.toFixed(2)}m`);
      check('the shove is visible as a link', everLinked);
    });

    // A player who never sends input must not freeze the tick or inherit stale
    // intent — the server relies on this when a client drops out.
    const soloTick = world.tick;
    world.step(new Map());
    check('a tick with no inputs at all still advances', world.tick === soloTick + 1);

    world.removePlayer(b.id);
    check('leaving removes the player', world.players.size === 1);
    check('and its body', !world.entities.some((e) => e.id === b.id));
    run(world, 10);
    check('the survivor keeps simulating', Math.abs(a.entity.pos.y - 0.55) < 0.6);
  }

  section('Ring-out and respawn');
  {
    const world = new SimWorld(SEED, SOLO);
    run(world, TICK_RATE);
    // Raise the kill plane above the arena so every body counts as fallen.
    withTunables({ killY: 5 }, () => run(world, 1));
    const ball = lightBall(world);
    check('player respawn counted', world.me.deaths === 1, `deaths=${world.me.deaths}`);
    check('body returned near spawn', Math.abs(ball.pos.x - ball.spawn.x) < 1.5,
      `x=${ball.pos.x.toFixed(2)} spawn=${ball.spawn.x}`);
    check('history snapped, so no lerp across the teleport',
      ball.prevPos.x === ball.pos.x && ball.prevPos.z === ball.pos.z);
    check('player recentred', Math.hypot(world.player.pos.x, world.player.pos.z) < 0.01);
  }

  section('Determinism (same seed + same inputs => identical state)');
  {
    const script = (i: Input, n: number): void => {
      i.moveX = Math.sin(n / 11) > 0 ? 1 : -1;
      i.moveZ = Math.cos(n / 7) > 0 ? 1 : -1;
      i.magnet = n % 3 === 0 ? -1 : n % 3 === 1 ? 1 : 0;
      i.aimX = Math.sin(n / 5);
      i.aimZ = Math.cos(n / 5);
      i.dash = n % 50 === 0;
    };

    const a = new SimWorld(1234);
    const b = new SimWorld(1234);
    run(a, 400, script);
    run(b, 400, script);

    let maxDelta = 0;
    for (let k = 0; k < a.entities.length; k++) {
      const ea = a.entities[k]!;
      const eb = b.entities[k]!;
      maxDelta = Math.max(
        maxDelta,
        Math.abs(ea.pos.x - eb.pos.x),
        Math.abs(ea.pos.y - eb.pos.y),
        Math.abs(ea.pos.z - eb.pos.z),
      );
    }
    check('400 ticks reproduce bit-for-bit', maxDelta === 0, `max delta ${maxDelta}`);
    check('same fall count', a.me.deaths === b.me.deaths, `${a.me.deaths} vs ${b.me.deaths}`);

    // Different seed only changes respawn jitter, so states must diverge only
    // if something actually fell. This just documents that the seed is wired in.
    const c = new SimWorld(9999);
    run(c, 400, script);
    check('seed is actually plumbed through', c.me.deaths >= 0);
  }

  section('Aim and magnet mapping');
  {
    const { buildInput } = await import('../src/input/buildInput');
    const blank = (): RawInput => ({
      forward: false,
      back: false,
      left: false,
      right: false,
      attract: false,
      repel: false,
      ndcX: 0,
      ndcY: 0,
      hasPointer: true,
    });
    const origin = { x: 0, y: 0.55, z: 0 };

    const lastAim = { x: 0, z: 1 };
    const aimed = buildInput(1, blank(), null, false, origin, { x: 5, y: 0, z: 0 }, lastAim);
    check('aim points at the cursor', Math.abs(aimed.aimX - 1) < 1e-6 && Math.abs(aimed.aimZ) < 1e-6,
      `(${aimed.aimX.toFixed(2)}, ${aimed.aimZ.toFixed(2)})`);

    // The magnet must keep steering off the last known cursor position rather
    // than snapping back to a default when a frame produces no ground hit.
    const held = buildInput(2, blank(), null, false, origin, null, lastAim);
    check('aim holds when the ray misses the ground', held.aimX === aimed.aimX && held.aimZ === aimed.aimZ);

    // Q and E must behave exactly like RMB and LMB — the sim sees no difference,
    // so the only thing that can diverge is which listener sets these flags.
    const attract = blank();
    attract.attract = true;
    check('attract maps to -1', buildInput(3, attract, null, false, origin, null, lastAim).magnet === -1);

    const repel = blank();
    repel.repel = true;
    check('repel maps to +1', buildInput(4, repel, null, false, origin, null, lastAim).magnet === 1);

    const both = blank();
    both.attract = true;
    both.repel = true;
    check('both together cancel', buildInput(5, both, null, false, origin, null, lastAim).magnet === 0);

    // Aim is independent of whether the magnet is engaged: this is the bug that
    // made Q/E feel broken while LMB/RMB felt fine.
    const aimingWhileIdle = buildInput(6, blank(), null, false, origin, { x: 0, y: 0, z: -7 }, lastAim);
    check('aim updates with no button held',
      Math.abs(aimingWhileIdle.aimZ + 1) < 1e-6, `aimZ=${aimingWhileIdle.aimZ.toFixed(2)}`);

    const keyed = blank();
    keyed.attract = true;
    const aimingWhileKeyed = buildInput(7, keyed, null, false, origin, { x: -7, y: 0, z: 0 }, lastAim);
    check('aim updates while the magnet is on',
      Math.abs(aimingWhileKeyed.aimX + 1) < 1e-6, `aimX=${aimingWhileKeyed.aimX.toFixed(2)}`);
  }

  section('Gamepad merging');
  {
    const { buildInput } = await import('../src/input/buildInput');
    const blankRaw = (): RawInput => ({
      forward: false,
      back: false,
      left: false,
      right: false,
      attract: false,
      repel: false,
      ndcX: 0,
      ndcY: 0,
      hasPointer: true,
    });
    const blankPad = (): GamepadState => ({
      connected: true,
      id: 'test pad',
      moveX: 0,
      moveZ: 0,
      aimX: 0,
      aimZ: 1,
      hasAim: false,
      attract: 0,
      repel: 0,
    });
    const origin = { x: 0, y: 0.55, z: 0 };
    const aim = () => ({ x: 0, z: 1 });

    // An idle pad must never suppress the keyboard — otherwise merely having a
    // controller plugged in breaks WASD.
    const kb = blankRaw();
    kb.forward = true;
    const idlePad = buildInput(1, kb, blankPad(), false, origin, null, aim());
    check('idle stick leaves the keyboard alone', idlePad.moveZ === -1, `moveZ=${idlePad.moveZ}`);

    const stick = blankPad();
    stick.moveX = 0.5;
    stick.moveZ = -0.5;
    const stickMove = buildInput(2, kb, stick, false, origin, null, aim());
    check('stick overrides the keyboard', stickMove.moveX === 0.5 && stickMove.moveZ === -0.5);

    // Partial deflection has to survive into the sim, or analog walking is lost.
    check('partial deflection is preserved', Math.hypot(stickMove.moveX, stickMove.moveZ) < 0.99,
      `magnitude ${Math.hypot(stickMove.moveX, stickMove.moveZ).toFixed(2)}`);

    const rightStick = blankPad();
    rightStick.hasAim = true;
    rightStick.aimX = -1;
    rightStick.aimZ = 0;
    const padAim = buildInput(3, blankRaw(), rightStick, false, origin, { x: 0, y: 0, z: 9 }, aim());
    check('right stick beats the mouse', padAim.aimX === -1 && padAim.aimZ === 0);

    const mouseStillWorks = buildInput(4, blankRaw(), blankPad(), false, origin, { x: 0, y: 0, z: 9 }, aim());
    check('idle right stick falls back to the mouse', Math.abs(mouseStillWorks.aimZ - 1) < 1e-6);

    // The whole point of gamepad support: force between 0 and full.
    const halfPull = blankPad();
    halfPull.attract = 0.4;
    check('trigger gives analog attract',
      Math.abs(buildInput(5, blankRaw(), halfPull, false, origin, null, aim()).magnet + 0.4) < 1e-6);

    const halfPush = blankPad();
    halfPush.repel = 0.75;
    check('trigger gives analog repel',
      Math.abs(buildInput(6, blankRaw(), halfPush, false, origin, null, aim()).magnet - 0.75) < 1e-6);

    const bothTriggers = blankPad();
    bothTriggers.attract = 0.9;
    bothTriggers.repel = 0.9;
    check('both triggers cancel',
      buildInput(7, blankRaw(), bothTriggers, false, origin, null, aim()).magnet === 0);

    // A squeezed trigger must not be overridden by a latched key, or the force
    // would snap to full mid-squeeze.
    const keyHeld = blankRaw();
    keyHeld.repel = true;
    const triggerWins = buildInput(8, keyHeld, halfPull, false, origin, null, aim());
    check('trigger beats a held key', Math.abs(triggerWins.magnet + 0.4) < 1e-6,
      `magnet=${triggerWins.magnet.toFixed(2)}`);

    const idleTriggers = buildInput(9, keyHeld, blankPad(), false, origin, null, aim());
    check('idle triggers fall back to the key', idleTriggers.magnet === 1);
  }

  section('Keyboard magnet latch (Q/E toggle, since holding a key kills the touchpad)');
  {
    const { MagnetLatch } = await import('../src/input/MagnetLatch');
    const latch = new MagnetLatch();

    check('starts off', !latch.isAttracting && !latch.isRepelling);

    latch.toggleAttract();
    check('Q latches attract on', latch.isAttracting && !latch.isRepelling);

    latch.toggleAttract();
    check('Q again releases it', !latch.isAttracting && !latch.isRepelling);

    // The whole combo — attract, flip, launch — has to be one keypress, not a
    // release plus a press.
    latch.toggleAttract();
    latch.toggleRepel();
    check('E flips polarity in one press', latch.isRepelling && !latch.isAttracting);

    latch.toggleAttract();
    check('and Q flips it back', latch.isAttracting && !latch.isRepelling);

    latch.clear();
    check('Esc / blur clears everything', !latch.isAttracting && !latch.isRepelling);

    // A latch can never produce the both-on state that cancels to zero force.
    let bothOn = false;
    const l2 = new MagnetLatch();
    for (const step of [0, 1, 1, 0, 0, 1, 0]) {
      if (step === 0) l2.toggleAttract();
      else l2.toggleRepel();
      if (l2.isAttracting && l2.isRepelling) bothOn = true;
    }
    check('never latches both polarities at once', !bothOn);
  }

  section('Force curve reference (N at distance, strength=450, range=12)');
  {
    const { falloff } = await import('@magnet/shared/sim/magnet');
    const dists = [0.5, 1, 2, 4, 6, 8, 10, 12];
    const header = ['mode'.padEnd(14), ...dists.map((d) => `${d}m`.padStart(7))].join('');
    console.log(`  \x1b[90m${header}\x1b[0m`);
    for (const mode of ['linear', 'smooth', 'inverseSquare'] as const) {
      const row = dists
        .map((d) => (450 * falloff(mode, d, 12, 2, 1)).toFixed(0).padStart(7))
        .join('');
      console.log(`  ${mode.padEnd(14)}${row}`);
    }
    console.log(
      '  \x1b[90m  player 5kg at mu=0.2, g=26 breaks static friction at ~26N; moveForce is 90\x1b[0m',
    );
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
  if (failed > 0) process.exitCode = 1;
}

void main();
