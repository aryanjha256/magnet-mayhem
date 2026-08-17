import { BODY_STRIDE, PLAYER_STRIDE, type SnapshotMessage } from '@magnet/shared/net/protocol';
import { MATCH_PHASES } from '@magnet/shared/sim/Match';
import { TUNABLES } from '@magnet/shared/sim/tunables';
import type { SimWorld } from '@magnet/shared/sim/World';

/**
 * Renders the world slightly in the past, interpolating between the two
 * snapshots that bracket the render clock.
 *
 * This is the deliberate choice not to attempt rollback. Rolling back a shared
 * physics world means re-simulating every body for every late packet, and it
 * is where this kind of project dies. Snapshot interpolation costs a fixed
 * delay and nothing else.
 *
 * The cost is real and specific to this game: the ball you aim at is where it
 * *was*. Predicting the bodies inside your own magnet radius is the eventual
 * fix, and it slots in on top of this rather than replacing it.
 */

/**
 * How far behind the newest snapshot to render, in sim ticks. Two snapshot
 * intervals of slack absorbs ordinary jitter without feeling sluggish.
 */
const DELAY_TICKS = 6;

/** Beyond this the clock has lost the plot — jump instead of easing. */
const RESYNC_TICKS = 30;

const MAX_BUFFERED = 32;

export class SnapshotBuffer {
  private readonly snapshots: SnapshotMessage[] = [];
  /** Fractional sim tick currently being displayed. */
  private renderTick = 0;
  private started = false;

  push(snapshot: SnapshotMessage): void {
    // Late or duplicate packets would otherwise corrupt the ordering the
    // bracket search relies on.
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && snapshot.tick <= last.tick) return;

    this.snapshots.push(snapshot);
    if (!this.started) {
      this.renderTick = snapshot.tick - DELAY_TICKS;
      this.started = true;
    }
    while (this.snapshots.length > MAX_BUFFERED) this.snapshots.shift();
  }

  get latest(): SnapshotMessage | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  get ready(): boolean {
    return this.snapshots.length >= 2;
  }

  /** Ticks between what the server has sent and what is on screen. */
  get delayTicks(): number {
    const newest = this.latest;
    return newest ? newest.tick - this.renderTick : 0;
  }

  /**
   * Advance the render clock and write interpolated transforms into `world`.
   * The world is never stepped — the server owns the physics.
   */
  apply(
    world: SimWorld,
    dt: number,
    tickRate: number,
    skipId = 0,
    ownership?: Ownership,
  ): void {
    const newest = this.latest;
    if (!newest || this.snapshots.length < 2) return;

    this.renderTick += dt * tickRate;

    const target = newest.tick - DELAY_TICKS;
    if (Math.abs(target - this.renderTick) > RESYNC_TICKS) {
      this.renderTick = target;
    } else {
      // Ease toward the target instead of snapping, so a jittery arrival rate
      // shows up as a slight speed change rather than a visible stutter.
      this.renderTick += (target - this.renderTick) * Math.min(1, dt * 2);
    }

    // Never extrapolate past what the server has actually told us.
    const oldest = this.snapshots[0]!;
    if (this.renderTick < oldest.tick) this.renderTick = oldest.tick;
    if (this.renderTick > newest.tick) this.renderTick = newest.tick;

    let a = this.snapshots[0]!;
    let b = newest;
    for (let i = 0; i < this.snapshots.length - 1; i++) {
      const lo = this.snapshots[i]!;
      const hi = this.snapshots[i + 1]!;
      if (this.renderTick >= lo.tick && this.renderTick <= hi.tick) {
        a = lo;
        b = hi;
        break;
      }
    }
    while (this.snapshots.length > 2 && this.snapshots[1]!.tick < a.tick) {
      this.snapshots.shift();
    }

    const span = b.tick - a.tick;
    const alpha = span > 0 ? (this.renderTick - a.tick) / span : 0;
    applyBodies(world, a, b, alpha, skipId, tickRate, ownership);
    applyPlayers(world, newest);
    applyMatch(world, newest);
    // With object prediction on, the local sim already produced links for every
    // magnet in the room and they are a frame fresh rather than 100ms stale.
    if (!ownership?.enabled) applyLinks(world, newest);
  }
}

const ROT = { x: 0, y: 0, z: 0, w: 1 };

/** Lets the caller keep local control of bodies it is predicting. */
export interface Ownership {
  readonly enabled: boolean;
  weightFor(id: number): number;
  abandon(id: number): void;
}

function applyBodies(
  world: SimWorld,
  a: SnapshotMessage,
  b: SnapshotMessage,
  alpha: number,
  skipId: number,
  tickRate: number,
  ownership?: Ownership,
): void {
  const next = new Map<number, number>();
  for (let i = 0; i < b.b.length; i += BODY_STRIDE) next.set(b.b[i]!, i);

  const span = Math.max(1, b.tick - a.tick) / tickRate;

  for (let i = 0; i < a.b.length; i += BODY_STRIDE) {
    const id = a.b[i]!;
    // The predicted player owns itself; stamping the server's stale position
    // over it every frame is exactly what prediction exists to avoid.
    if (id === skipId) continue;

    const entity = world.entities.find((e) => e.id === id);
    if (!entity) continue;

    const j = next.get(id);
    const t = j === undefined ? 0 : alpha;
    const src = j === undefined ? a.b : b.b;
    const k = j ?? i;

    const x = lerp(a.b[i + 1]!, src[k + 1]!, t);
    const y = lerp(a.b[i + 2]!, src[k + 2]!, t);
    const z = lerp(a.b[i + 3]!, src[k + 3]!, t);
    nlerpInto(ROT, a.b, i + 4, src, k + 4, t);

    // Velocity is derived from the snapshot pair rather than sent on the wire.
    // The predicted player collides with these bodies, and one teleported each
    // tick with zero velocity behaves like a wall instead of like a moving ball.
    const vx = j === undefined ? 0 : (b.b[k + 1]! - a.b[i + 1]!) / span;
    const vy = j === undefined ? 0 : (b.b[k + 2]! - a.b[i + 2]!) / span;
    const vz = j === undefined ? 0 : (b.b[k + 3]! - a.b[i + 3]!) / span;

    const weight = ownership?.weightFor(id) ?? 0;
    if (weight > 0) {
      // How far the local guess has drifted from the server's version.
      const drift = Math.hypot(entity.pos.x - x, entity.pos.y - y, entity.pos.z - z);
      if (drift > TUNABLES.objectDivergenceLimit) {
        // Someone else is pulling this too, or it hit something we did not
        // simulate. Hand it straight back rather than fighting over it.
        ownership?.abandon(id);
      } else if (weight >= 1) {
        // Fully ours: leave the local physics result alone entirely.
        continue;
      } else {
        // Fading home. Blending the position rather than snapping is what
        // stops a released ball teleporting the moment you let go.
        const t = 1 - weight;
        world.setBodyState(
          id,
          {
            x: entity.pos.x + (x - entity.pos.x) * t,
            y: entity.pos.y + (y - entity.pos.y) * t,
            z: entity.pos.z + (z - entity.pos.z) * t,
          },
          ROT,
          { x: vx, y: vy, z: vz },
        );
        continue;
      }
    }

    world.setBodyState(id, { x, y, z }, ROT, { x: vx, y: vy, z: vz });
  }
}

function applyPlayers(world: SimWorld, snap: SnapshotMessage): void {
  for (let i = 0; i < snap.p.length; i += PLAYER_STRIDE) {
    const state = world.players.get(snap.p[i]!);
    if (!state) continue;
    state.magnetAxis = snap.p[i + 1]!;
    state.aimX = snap.p[i + 2]!;
    state.aimZ = snap.p[i + 3]!;
    state.deaths = snap.p[i + 4]!;
    state.knockouts = snap.p[i + 5]!;
    const alive = snap.p[i + 6] === 1;
    if (alive !== state.alive) world.setBodyEnabled(state.id, alive);
    state.alive = alive;
    state.roundWins = snap.p[i + 7]!;
  }
}

/** The server owns the round clock; the client only mirrors it. */
function applyMatch(world: SimWorld, snap: SnapshotMessage): void {
  const m = snap.m;
  if (m.length < 6) return;
  world.match.phase = MATCH_PHASES[m[0]!] ?? 'playing';
  world.match.timer = m[1]!;
  world.match.round = m[2]!;
  // Through the setter, so the client's platform collider shrinks with the
  // server's. Otherwise a predicting player walks on floor that is not there.
  world.setArenaRadius(m[3]!);
  world.match.lastWinner = m[4]!;
  world.match.champion = m[5]!;
}

function applyLinks(world: SimWorld, snap: SnapshotMessage): void {
  world.links.length = 0;
  for (let i = 0; i < snap.l.length; i += 3) {
    world.links.push({ sourceId: snap.l[i]!, targetId: snap.l[i + 1]!, force: snap.l[i + 2]! });
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Normalized lerp rather than true slerp. Over a 50 ms snapshot gap the angular
 * error is invisible, and it keeps this file free of a maths dependency.
 */
function nlerpInto(
  out: { x: number; y: number; z: number; w: number },
  a: number[],
  ai: number,
  b: number[],
  bi: number,
  t: number,
): void {
  let bx = b[bi]!;
  let by = b[bi + 1]!;
  let bz = b[bi + 2]!;
  let bw = b[bi + 3]!;
  const ax = a[ai]!;
  const ay = a[ai + 1]!;
  const az = a[ai + 2]!;
  const aw = a[ai + 3]!;

  // Quaternions double-cover rotations: without this the shorter arc is not
  // guaranteed and bodies occasionally spin the long way round.
  if (ax * bx + ay * by + az * bz + aw * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  const x = lerp(ax, bx, t);
  const y = lerp(ay, by, t);
  const z = lerp(az, bz, t);
  const w = lerp(aw, bw, t);
  const len = Math.hypot(x, y, z, w) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  out.w = w / len;
}
