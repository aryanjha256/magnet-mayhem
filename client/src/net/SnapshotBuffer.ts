import { BODY_STRIDE, PLAYER_STRIDE, type SnapshotMessage } from '@magnet/shared/net/protocol';
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
  apply(world: SimWorld, dt: number, tickRate: number): void {
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
    applyBodies(world, a, b, alpha);
    applyPlayers(world, newest);
    applyLinks(world, newest);
  }
}

function applyBodies(
  world: SimWorld,
  a: SnapshotMessage,
  b: SnapshotMessage,
  alpha: number,
): void {
  const next = new Map<number, number>();
  for (let i = 0; i < b.b.length; i += BODY_STRIDE) next.set(b.b[i]!, i);

  for (let i = 0; i < a.b.length; i += BODY_STRIDE) {
    const id = a.b[i]!;
    const entity = world.entities.find((e) => e.id === id);
    if (!entity) continue;

    const j = next.get(id);
    const t = j === undefined ? 0 : alpha;
    const src = j === undefined ? a.b : b.b;
    const k = j ?? i;

    const x = lerp(a.b[i + 1]!, src[k + 1]!, t);
    const y = lerp(a.b[i + 2]!, src[k + 2]!, t);
    const z = lerp(a.b[i + 3]!, src[k + 3]!, t);

    // Already interpolated, so collapse the render-side history onto it —
    // otherwise the renderer would interpolate an interpolation.
    entity.pos.x = x;
    entity.pos.y = y;
    entity.pos.z = z;
    entity.prevPos.x = x;
    entity.prevPos.y = y;
    entity.prevPos.z = z;

    nlerpInto(entity.rot, a.b, i + 4, src, k + 4, t);
    entity.prevRot.x = entity.rot.x;
    entity.prevRot.y = entity.rot.y;
    entity.prevRot.z = entity.rot.z;
    entity.prevRot.w = entity.rot.w;
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
  }
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
