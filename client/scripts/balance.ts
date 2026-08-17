/**
 * Difficulty probe. `npm run balance`
 *
 * Two stand-ins for a human, because they measure opposite things:
 *
 *   passive  never moves. Sounds like a worst case, but standing dead centre
 *            is the safest spot on the map, so it flatters the bots badly and
 *            does not reproduce how the game actually feels.
 *   active   plays the same policy the bots do. Chases, commits to shoves, and
 *            therefore spends real time near the edge — which is where players
 *            actually die. This is the number worth watching.
 *
 * Neither is a skilled human. They bracket the range.
 */
import { BotDirector, decideBot, type BotTarget } from '@magnet/shared/sim/Bot';
import { emptyInput, type Input } from '@magnet/shared/sim/input';
import { TUNABLES, type Tunables } from '@magnet/shared/sim/tunables';
import type { EntityId } from '@magnet/shared/sim/types';
import { initSim, SimWorld, TICK_RATE } from '@magnet/shared/sim/World';

const SECONDS = 60;

interface Result {
  humanDeaths: number;
  botDeaths: number;
}

/**
 * A human's edge awareness is nothing like a bot's — no projected-position
 * maths, no bailing out half a second early. Modelling the stand-in human with
 * a much lower `botCaution` than the bots is what reproduces the asymmetry that
 * actually kills players.
 */
const HUMAN_CAUTION = 0.2;

function trial(bots: number, overrides: Partial<Tunables>, active = false): Result {
  const saved: Tunables = { ...TUNABLES };
  Object.assign(TUNABLES, overrides);
  try {
    const world = new SimWorld(0x5eed, { players: 1, bots, match: false });
    const director = new BotDirector();
    const inputs = new Map<EntityId, Input>();
    const humanId = world.playerId;

    const targets: BotTarget[] = [];
    for (let i = 0; i < TICK_RATE * SECONDS; i++) {
      inputs.clear();

      const me = world.players.get(humanId)!;
      if (active) {
        targets.length = 0;
        for (const other of world.players.values()) {
          if (other.id !== humanId) targets.push({ id: other.id, pos: other.entity.pos });
        }
        const botCaution = TUNABLES.botCaution;
        TUNABLES.botCaution = HUMAN_CAUTION;
        inputs.set(
          humanId,
          decideBot(
            { id: humanId, pos: me.entity.pos, vel: me.velocity, dashReady: me.dashCooldown === 0 },
            targets,
            world.tick + 1,
            world.arenaRadius,
          ),
        );
        TUNABLES.botCaution = botCaution;
      } else {
        inputs.set(humanId, emptyInput(world.tick + 1));
      }

      director.drive(world, inputs);
      world.step(inputs);
    }

    let botDeaths = 0;
    for (const p of world.players.values()) if (p.isBot) botDeaths += p.deaths;
    return { humanDeaths: world.players.get(humanId)!.deaths, botDeaths };
  } finally {
    Object.assign(TUNABLES, saved);
  }
}

async function main(): Promise<void> {
  await initSim();

  const OLD: Partial<Tunables> = {
    botReactionTicks: 1,
    botAimErrorDeg: 6.9,
    botMagnetScale: 1,
    botCaution: 1,
  };

  console.log(`\n\x1b[1mACTIVE human — plays like a bot, ${SECONDS}s per run\x1b[0m\n`);
  const rows: [string, Result][] = [
    ['old build (3 bots, frame-perfect)', trial(3, OLD, true)],
    ['new defaults (2 bots)', trial(2, {}, true)],
    ['new defaults, 3 bots', trial(3, {}, true)],
    ['new defaults but paranoid bots (caution 1)', trial(2, { botCaution: 1 }, true)],
    ['easiest sliders (2 bots)',
      trial(2, { botReactionTicks: 20, botAimErrorDeg: 30, botMagnetScale: 0.4, botCaution: 0.35 }, true)],
  ];

  console.log(`  ${'setup'.padEnd(42)}${'you fall'.padStart(10)}${'they fall'.padStart(11)}`);
  for (const [label, r] of rows) {
    console.log(
      `  ${label.padEnd(42)}${String(r.humanDeaths).padStart(10)}${String(r.botDeaths).padStart(11)}`,
    );
  }
  console.log(`\n\x1b[1mPASSIVE human — never moves, ${SECONDS}s per run\x1b[0m\n`);
  const passive: [string, Result][] = [
    ['old build (3 bots, frame-perfect)', trial(3, OLD)],
    ['new defaults (2 bots)', trial(2, {})],
  ];
  console.log(`  ${'setup'.padEnd(42)}${'you fall'.padStart(10)}${'they fall'.padStart(11)}`);
  for (const [label, r] of passive) {
    console.log(
      `  ${label.padEnd(42)}${String(r.humanDeaths).padStart(10)}${String(r.botDeaths).padStart(11)}`,
    );
  }
  console.log(
    '\n  \x1b[90mStanding still is the safest strategy in the game, which is why the\n' +
      '  passive numbers look tame. Tune live in the browser under "Bots".\x1b[0m\n',
  );
  process.exit(0);
}

void main();
