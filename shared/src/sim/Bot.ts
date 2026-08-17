import { emptyInput, type Input } from './input';
import { TUNABLES } from './tunables';
import type { EntityId, Vec3 } from './types';
import type { SimWorld } from './World';

/**
 * Bot opponents.
 *
 * A bot is not an entity type — it is an *input source*. `decideBot` returns
 * the same `Input` struct a keyboard or a network packet produces, so the
 * simulation cannot tell a bot from a human, and the same code drives them in
 * the solo sandbox and inside a server room.
 *
 * `decideBot` is stateless and free of wall-clock time, so it stays
 * deterministic and unit-testable. `BotDirector` below adds the one piece of
 * state that matters — reaction delay.
 */

/** Fraction of the platform half-extent that still counts as safe ground. */
const PANIC_RADIUS = 0.78;

/** Seconds of velocity to project forward when judging danger. */
const LOOKAHEAD = 0.5;

/** How far inside a target the bot wants to stand before shoving. */
const STANDOFF = 4;

/** Beyond this the bot commits to a shove instead of repositioning. */
const ALIGNMENT_THRESHOLD = 0.25;

/** A target this close to the middle cannot be pushed out from anywhere. */
const MIN_TARGET_RADIUS = 0.3;

export interface BotSelf {
  id: EntityId;
  pos: Vec3;
  vel: Vec3;
  dashReady: boolean;
}

export interface BotTarget {
  id: EntityId;
  pos: Vec3;
  /** Another bot is already going for this one. Deprioritised, not banned. */
  claimed?: boolean;
}

/** Distance a claimed target is treated as being further away, in metres. */
const CLAIM_PENALTY = 7;

/**
 * Nearest target, with claimed ones pushed down the list. Exported so the
 * director can record the same choice `decideBot` will make.
 */
export function pickTarget(
  selfPos: Vec3,
  targets: readonly BotTarget[],
): BotTarget | null {
  let best: BotTarget | null = null;
  let bestScore = Infinity;
  for (const candidate of targets) {
    const range = Math.hypot(candidate.pos.x - selfPos.x, candidate.pos.z - selfPos.z);
    const score = candidate.claimed === true ? range + CLAIM_PENALTY : range;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

export function decideBot(
  self: BotSelf,
  targets: readonly BotTarget[],
  tick: number,
  arenaHalf: number,
): Input {
  const out = emptyInput(tick);

  // --- 1. Am I about to die? ---------------------------------------------
  // Judged on projected position, not current. Being flung is the normal way
  // to travel here, so position alone is a lagging indicator — by the time a
  // bot is over the edge it is far too late to walk back.
  // Caution scales both how far ahead it looks and how close to the rim it
  // tolerates. At 1 a bot bails so early it is effectively unkillable, which
  // is not an opponent — it is a wall.
  const caution = TUNABLES.botCaution;
  const futureX = self.pos.x + self.vel.x * LOOKAHEAD * caution;
  const futureZ = self.pos.z + self.vel.z * LOOKAHEAD * caution;
  const projected = Math.hypot(futureX, futureZ);
  const panicAt = arenaHalf * (1 - (1 - PANIC_RADIUS) * caution);

  if (projected > panicAt) {
    const here = Math.hypot(self.pos.x, self.pos.z) || 1;
    const inwardX = -self.pos.x / here;
    const inwardZ = -self.pos.z / here;

    out.moveX = inwardX;
    out.moveZ = inwardZ;
    out.aimX = inwardX;
    out.aimZ = inwardZ;
    // Attract whatever mass lies between here and the middle. Against the
    // heavy crates this is a grapple back to safety, which is the same trick
    // a good human player uses.
    out.magnet = -1;
    out.dash = self.dashReady;
    return out;
  }

  // --- 2. Who am I fighting? ---------------------------------------------
  const target = pickTarget(self.pos, targets);

  if (!target) {
    // Nobody left. Drift back to the middle rather than idling on a ledge.
    const here = Math.hypot(self.pos.x, self.pos.z);
    if (here > arenaHalf * 0.3) {
      out.moveX = -self.pos.x / here;
      out.moveZ = -self.pos.z / here;
    }
    return out;
  }

  const toTargetX = target.pos.x - self.pos.x;
  const toTargetZ = target.pos.z - self.pos.z;
  const toTarget = Math.hypot(toTargetX, toTargetZ) || 1;
  out.aimX = toTargetX / toTarget;
  out.aimZ = toTargetZ / toTarget;

  // Aim error. Without it a bot never misses, which reads as cheating rather
  // than as an opponent; `id` keeps two bots out of lockstep. Driven off tick
  // rather than a RNG so replays stay identical.
  const spread = (TUNABLES.botAimErrorDeg * Math.PI) / 180;
  const wobble = Math.sin(tick * 0.05 + self.id * 1.7) * spread;
  const cos = Math.cos(wobble);
  const sin = Math.sin(wobble);
  const aimX = out.aimX * cos - out.aimZ * sin;
  const aimZ = out.aimX * sin + out.aimZ * cos;
  out.aimX = aimX;
  out.aimZ = aimZ;

  // --- 3. Shove, or get into position to shove? --------------------------
  // Repelling only rings someone out if they are further from the middle than
  // you are, so the whole tactic reduces to: is my aim pointing outward?
  const targetRadius = Math.hypot(target.pos.x, target.pos.z);
  const outwardX = targetRadius > MIN_TARGET_RADIUS ? target.pos.x / targetRadius : out.aimX;
  const outwardZ = targetRadius > MIN_TARGET_RADIUS ? target.pos.z / targetRadius : out.aimZ;
  const alignment = out.aimX * outwardX + out.aimZ * outwardZ;

  const inRange = toTarget < TUNABLES.magnetRange * 0.9;

  if (inRange && alignment > ALIGNMENT_THRESHOLD) {
    out.magnet = TUNABLES.botMagnetScale;
    // Standing still while shoving: walking forward would close the gap and
    // drag the bot toward the edge on its own recoil.
    return out;
  }

  // Not lined up. Move to the spot between the target and the middle, which
  // is the position every shove is launched from.
  const goalX = target.pos.x - outwardX * STANDOFF;
  const goalZ = target.pos.z - outwardZ * STANDOFF;
  const toGoalX = goalX - self.pos.x;
  const toGoalZ = goalZ - self.pos.z;
  const toGoal = Math.hypot(toGoalX, toGoalZ);

  if (toGoal > 0.5) {
    out.moveX = toGoalX / toGoal;
    out.moveZ = toGoalZ / toGoal;
    // Dash to close a long gap, never while already near the edge.
    out.dash = self.dashReady && toGoal > 6 && projected < panicAt * 0.8;
  }

  // Pull a distant target closer instead of standing around waiting.
  if (inRange && alignment < -ALIGNMENT_THRESHOLD) out.magnet = -TUNABLES.botMagnetScale;

  return out;
}

/**
 * Drives every bot in a world.
 *
 * Stateful, unlike `decideBot`, because the single biggest thing separating a
 * bot from a human is *reaction time*. Re-deciding every tick at 60 Hz means
 * perfect tracking and no way to juke one — which is exactly how the first
 * build ended up unwinnable. Holding a decision for a few ticks is what makes
 * them beatable.
 *
 * Lives outside `SimWorld` on purpose: the sim is mechanism, this is policy.
 * The world does not import this file, so bots can never touch physics except
 * through the same Input everyone else uses.
 */
export class BotDirector {
  private readonly held = new Map<EntityId, { input: Input; until: number }>();

  drive(world: SimWorld, inputs: Map<EntityId, Input>): void {
    const tick = world.tick + 1;
    const hold = Math.max(1, Math.round(TUNABLES.botReactionTicks));

    // Targets already picked this tick, so three bots do not all converge on
    // whoever happens to be nearest — a dogpile is unsurvivable and reads as
    // the game being unfair rather than hard.
    const claimed = new Set<EntityId>();

    for (const state of world.players.values()) {
      if (!state.isBot || !state.alive) continue;

      const memory = this.held.get(state.id);
      if (memory && tick < memory.until) {
        // Reuse the stale decision. Dash is an edge, so it fires once only.
        memory.input.tick = tick;
        inputs.set(state.id, memory.input);
        memory.input.dash = false;
        continue;
      }

      const targets: BotTarget[] = [];
      for (const other of world.players.values()) {
        if (other.id === state.id || !other.alive) continue;
        targets.push({ id: other.id, pos: other.entity.pos, claimed: claimed.has(other.id) });
      }

      const input = decideBot(
        {
          id: state.id,
          pos: state.entity.pos,
          vel: state.velocity,
          dashReady: state.dashCooldown === 0,
        },
        targets,
        tick,
        world.arenaRadius,
      );

      const picked = pickTarget(state.entity.pos, targets);
      if (picked) claimed.add(picked.id);

      this.held.set(state.id, { input, until: tick + hold });
      inputs.set(state.id, input);
    }
  }

  /** Forget a departed bot so its decision cannot leak into a recycled id. */
  forget(id: EntityId): void {
    this.held.delete(id);
  }
}
