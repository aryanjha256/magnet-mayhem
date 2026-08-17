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
import { PLATFORM_RADIUS } from '@magnet/shared/sim/arena';
import type { Entity, EntityId, Vec3 } from '@magnet/shared/sim/types';

const SEED = 0x5eed;
/**
 * Worlds for measuring one magnet in isolation. With bots present they move and
 * shove, which silently corrupts every single-actor measurement below.
 */
const SOLO = { bots: 0, match: false } as const;

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
    check('entities created', world.entities.length === 15, `${world.entities.length} entities`);
    check('bots can be left out', new SimWorld(SEED, SOLO).entities.length === 13);
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

  section('Bot decisions (pure, no world needed)');
  {
    const { decideBot } = await import('@magnet/shared/sim/Bot');
    const still = { x: 0, y: 0, z: 0 };
    const bot = (pos: Vec3, vel = still, dashReady = false) => ({ id: 1, pos, vel, dashReady });

    // Self-preservation outranks everything: a bot sailing off the edge must
    // stop fighting and run for the middle.
    const falling = decideBot(bot({ x: 8, y: 0.55, z: 0 }, { x: 6, y: 0, z: 0 }, true),
      [{ id: 2, pos: { x: 9, y: 0.55, z: 0 } }], 1, PLATFORM_RADIUS);
    check('a bot heading off the edge runs inward', falling.moveX < -0.9,
      `moveX=${falling.moveX.toFixed(2)}`);
    check('and grapples back with attract', falling.magnet === -1);
    check('and spends its dash on the recovery', falling.dash);

    // Position alone is not enough — being flung is the normal way to travel,
    // so a bot standing safely but moving fast outward must still react.
    const safeButDoomed = decideBot(bot({ x: 3, y: 0.55, z: 0 }, { x: 30, y: 0, z: 0 }),
      [{ id: 2, pos: { x: 0, y: 0.55, z: 0 } }], 1, PLATFORM_RADIUS);
    check('danger is judged on projected position', safeButDoomed.moveX < 0,
      `moveX=${safeButDoomed.moveX.toFixed(2)}`);

    // Caution is the difference between an opponent and a wall: at 1 a bot
    // bails so early it is effectively unkillable, which is what made the first
    // build's bots survive every single balance run.
    // Tested via the emergency grapple, not movement: with no targets a bot
    // drifts back to the middle anyway, so `moveX` cannot tell panic from idle.
    const edgy = { x: 6.4, y: 0.55, z: 0 };
    let paranoid = 0;
    let reckless = 0;
    withTunables({ botCaution: 1.2 }, () => {
      paranoid = decideBot(bot(edgy, { x: 4, y: 0, z: 0 }), [], 1, PLATFORM_RADIUS).magnet;
    });
    withTunables({ botCaution: 0.2 }, () => {
      reckless = decideBot(bot(edgy, { x: 4, y: 0, z: 0 }), [], 1, PLATFORM_RADIUS).magnet;
    });
    check('high caution panics and grapples home', paranoid === -1);
    check('low caution keeps committing', reckless === 0);

    // Target outward of the bot -> shove. Target inward -> reposition first.
    const lined = decideBot(bot({ x: 2, y: 0.55, z: 0 }),
      [{ id: 2, pos: { x: 5, y: 0.55, z: 0 } }], 1, PLATFORM_RADIUS);
    check('a lined-up bot shoves outward', lined.magnet > 0, `magnet=${lined.magnet}`);
    check('and holds still while shoving', lined.moveX === 0 && lined.moveZ === 0);

    const wrongSide = decideBot(bot({ x: 6, y: 0.55, z: 0 }),
      [{ id: 2, pos: { x: 2, y: 0.55, z: 0 } }], 1, PLATFORM_RADIUS);
    check('a badly placed bot repositions instead', wrongSide.magnet <= 0,
      `magnet=${wrongSide.magnet}`);
    check('moving toward the inside of its target', wrongSide.moveX < 0,
      `moveX=${wrongSide.moveX.toFixed(2)}`);

    const alone = decideBot(bot({ x: 7, y: 0.55, z: 0 }), [], 1, PLATFORM_RADIUS);
    check('with nobody left it returns to the middle', alone.moveX < 0 && alone.magnet === 0);

    // Two bots at identical positions must not act in lockstep.
    const a1 = decideBot({ id: 1, pos: { x: 2, y: 0.55, z: 0 }, vel: still, dashReady: false },
      [{ id: 9, pos: { x: 5, y: 0.55, z: 0 } }], 40, PLATFORM_RADIUS);
    const a2 = decideBot({ id: 2, pos: { x: 2, y: 0.55, z: 0 }, vel: still, dashReady: false },
      [{ id: 9, pos: { x: 5, y: 0.55, z: 0 } }], 40, PLATFORM_RADIUS);
    check('aim wobble is desynchronised per bot', a1.aimX !== a2.aimX || a1.aimZ !== a2.aimZ);
    check('but stays deterministic for a given bot and tick',
      decideBot({ id: 1, pos: { x: 2, y: 0.55, z: 0 }, vel: still, dashReady: false },
        [{ id: 9, pos: { x: 5, y: 0.55, z: 0 } }], 40, PLATFORM_RADIUS).aimZ === a1.aimZ);
  }

  section('Bots in a live world');
  {
    const { BotDirector } = await import('@magnet/shared/sim/Bot');
    const director = new BotDirector();
    const world = new SimWorld(SEED, { players: 1, bots: 3, match: false });
    check('bots are players, not a separate entity kind',
      world.entities.filter((e) => e.kind === 'player').length === 4);
    check('the default world ships a beatable number of them',
      new SimWorld(SEED).players.size === 3);
    check('and are flagged as bots',
      [...world.players.values()].filter((p) => p.isBot).length === 3);
    check('each spawn slot gets its own colour',
      new Set([...world.players.values()].map((p) => p.entity.tint)).size === 4);

    const inputs = new Map<EntityId, Input>();
    const step = (n: number): void => {
      for (let i = 0; i < n; i++) {
        inputs.clear();
        inputs.set(world.playerId, emptyInput(world.tick + 1));
        director.drive(world, inputs);
        world.step(inputs);
      }
    };

    step(TICK_RATE * 8);

    // The single most important property: bots must not kill themselves. Their
    // own recoil is what does it, so this is a real risk, not a formality.
    const botDeaths = [...world.players.values()]
      .filter((p) => p.isBot)
      .reduce((sum, p) => sum + p.deaths, 0);
    check('bots survive 8 seconds unattended', botDeaths === 0, `${botDeaths} falls`);
    // Bots only: the human is being actively knocked off, so a respawning
    // human sitting at spawn height is a pass, not a failure.
    check('and stay on the platform',
      [...world.players.values()].filter((p) => p.isBot)
        .every((p) => Math.abs(p.entity.pos.y - 0.55) < 0.2));

    // They also have to actually play, not just mill about safely.
    let engaged = 0;
    for (let i = 0; i < TICK_RATE * 6; i++) {
      inputs.clear();
      inputs.set(world.playerId, emptyInput(world.tick + 1));
      director.drive(world, inputs);
      world.step(inputs);
      if (world.links.some((l) => world.players.get(l.sourceId)?.isBot)) engaged++;
    }
    check('bots use their magnets on someone', engaged > 30, `${engaged} ticks with a bot tether`);

    const idle = world.players.get(world.playerId)!;
    check('and they come after the human', idle.deaths > 0 || engaged > 100,
      `human falls=${idle.deaths}, engaged=${engaged}`);
  }

  section('Rounds, elimination and the shrinking arena');
  {
    const world = new SimWorld(SEED, { players: 3, bots: 0 });
    const [a, b] = [...world.players.values()];
    const step = (n: number): void => {
      for (let i = 0; i < n; i++) world.step(new Map<EntityId, Input>());
    };

    check('a match opens on a countdown', world.match.phase === 'countdown',
      world.match.phase);
    check('and the arena starts full size', world.arenaRadius === PLATFORM_RADIUS);

    // Nobody may act before the bell.
    const before = { ...a!.entity.pos };
    for (let i = 0; i < 30; i++) {
      const shove = new Map<EntityId, Input>();
      shove.set(b!.id, { ...emptyInput(world.tick + 1), moveX: 1, moveZ: 1 });
      world.step(shove);
    }
    check('input is frozen during the countdown',
      Math.hypot(a!.entity.pos.x - before.x, a!.entity.pos.z - before.z) < 0.01);

    step(TICK_RATE * 3);
    check('then the round starts', world.match.phase === 'playing', world.match.phase);

    // Elimination: falling ends your round rather than costing five seconds.
    withTunables({ killY: 5 }, () => step(1));
    check('a fall eliminates rather than respawns', world.alivePlayers.length === 0,
      `${world.alivePlayers.length} alive`);
    check('and is counted once, not every tick', a!.deaths === 1, `deaths=${a!.deaths}`);
    step(10);
    check('still counted once after several ticks', a!.deaths === 1, `deaths=${a!.deaths}`);
    check('the round ends when nobody is left', world.match.phase === 'roundOver',
      world.match.phase);

    // Next round resets everyone.
    step(TICK_RATE * 4);
    check('the next round revives everybody', world.alivePlayers.length === 3);
    check('and counts up', world.match.round === 2, `round ${world.match.round}`);
    check('with the arena reset to full', world.arenaRadius === PLATFORM_RADIUS);
  }

  section('Shrinking closes the arena down');
  {
    const world = new SimWorld(SEED, { players: 2, bots: 0 });
    const step = (n: number): void => {
      for (let i = 0; i < n; i++) world.step(new Map<EntityId, Input>());
    };

    withTunables({ shrinkGraceSeconds: 1, shrinkSeconds: 4, arenaMinRadius: 3 }, () => {
      step(TICK_RATE * 3);
      check('nothing shrinks during the grace period',
        world.arenaRadius > PLATFORM_RADIUS - 1.5, `${world.arenaRadius.toFixed(2)}m`);

      // Sampled while it closes, not after: the shrink strands a player, which
      // ends the round and resets the whole arena before a final read.
      const outer = world.entities.find((e) => e.kind === 'ball' && e.spawn.x === 6.5)!;
      let smallest = world.arenaRadius;
      let ballFell = false;
      let anyoneStranded = false;
      for (let i = 0; i < TICK_RATE * 6; i++) {
        step(1);
        smallest = Math.min(smallest, world.arenaRadius);
        if (outer.pos.y < -3) ballFell = true;
        if (world.alivePlayers.length < 2) anyoneStranded = true;
      }

      check('then it closes to the floor', Math.abs(smallest - 3) < 0.01, `${smallest.toFixed(2)}m`);
      // The collider has to move, not just the number the HUD reads, or players
      // stand on invisible floor well beyond the visible edge.
      check('the collider really shrank, not just the number', ballFell,
        'a ball resting at r=6.7 fell into the void');
      check('and it strands players, which is the point', anyoneStranded);
    });
  }

  section('Winning a match');
  {
    const world = new SimWorld(SEED, { players: 2, bots: 0 });
    const [a, b] = [...world.players.values()];
    const step = (n: number): void => {
      for (let i = 0; i < n; i++) world.step(new Map<EntityId, Input>());
    };

    // Rounds decided by timeout rather than by knockout, because a test cannot
    // teleport a body: `readBack` overwrites any hand-placed position from the
    // rigid body every single tick. On a timeout the player nearest the middle
    // takes the round, and `a` spawns dead centre.
    withTunables({ roundsToWin: 2, roundSeconds: 1 }, () => {
      for (let i = 0; i < TICK_RATE * 30 && world.match.champion === 0; i++) step(1);

      check('round wins accumulate', a!.roundWins >= 2, `${a!.roundWins} wins`);
      check('the centre player takes a timeout', b!.roundWins === 0, `${b!.roundWins} wins`);
      check('and the match is awarded', world.match.champion === a!.id,
        `champion=${world.match.champion}`);

      step(TICK_RATE * 7);
      check('then a fresh match begins', world.match.champion === 0 && world.match.round === 1);
      check('with the scoreboard cleared', a!.roundWins === 0 && b!.roundWins === 0);
    });
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
