import type { EntityId, Vec3 } from '@magnet/shared/sim/types';
import type { SimWorld } from '@magnet/shared/sim/World';

/**
 * Client-side prediction for the local player.
 *
 * The client simulates the whole world locally but only *owns* one body: its
 * own player. Every other body is stamped back to the server's version each
 * frame, so local physics can never drift away from the room while your own
 * input still lands the instant you press it.
 *
 * This is deliberately not rollback. Re-simulating the shared world for every
 * late packet is where this kind of project dies. Instead:
 *
 *   1. remember where we predicted our player was on each tick
 *   2. when a snapshot for tick T arrives, compare it to prediction[T]
 *   3. fold that error into the *present* position, gradually
 *
 * Comparing against the same tick is the whole trick. Steering toward the raw
 * authoritative position instead would drag the player ~100 ms into the past
 * and fight every input.
 */

/** Ticks of prediction history to keep. Comfortably over a second. */
const HISTORY = 128;

/** Fraction of the outstanding error absorbed per tick. */
const CORRECTION_RATE = 0.12;

/** Past this the prediction is not worth saving — teleport instead. */
const SNAP_DISTANCE = 4;

/** Below this, leave it alone; chasing sub-centimetre error just jitters. */
const DEADZONE = 0.02;

/**
 * Disagreement that justifies correcting without a matching prediction sample.
 * Small mismatches are ordinary lag; metres mean we are genuinely lost.
 */
const RECOVERY_DISTANCE = 1.5;

interface Sample {
  tick: number;
  x: number;
  y: number;
  z: number;
}

export class Predictor {
  /** Metres between prediction and server truth at the last reconcile. */
  error = 0;
  corrections = 0;
  snaps = 0;
  /** Corrections made without a matching sample — clock drift or a respawn. */
  recoveries = 0;

  private readonly history: Sample[] = [];
  private pendingX = 0;
  private pendingY = 0;
  private pendingZ = 0;
  private lastReconciledTick = -1;

  record(tick: number, pos: Vec3): void {
    this.history.push({ tick, x: pos.x, y: pos.y, z: pos.z });
    while (this.history.length > HISTORY) this.history.shift();
  }

  reset(): void {
    this.history.length = 0;
    this.pendingX = 0;
    this.pendingY = 0;
    this.pendingZ = 0;
    this.lastReconciledTick = -1;
  }

  /**
   * Compare the server's word for `serverTick` against what we predicted then,
   * and queue the difference for gradual correction.
   */
  reconcile(serverTick: number, authoritative: Vec3, current: Vec3): void {
    if (serverTick <= this.lastReconciledTick) return;

    const sample = this.sampleAt(serverTick);
    if (!sample) {
      // No prediction recorded for that tick — the clocks have drifted apart,
      // or we just respawned. Silently doing nothing here is how a client ends
      // up permanently lost in the void with no way back, so fall back to a
      // blunt comparison against right now and let `apply` snap if it is bad.
      this.lastReconciledTick = serverTick;
      const dx = authoritative.x - current.x;
      const dy = authoritative.y - current.y;
      const dz = authoritative.z - current.z;
      this.error = Math.hypot(dx, dy, dz);
      if (this.error > RECOVERY_DISTANCE) {
        this.pendingX = dx;
        this.pendingY = dy;
        this.pendingZ = dz;
        this.recoveries++;
      }
      return;
    }
    this.lastReconciledTick = serverTick;

    const dx = authoritative.x - sample.x;
    const dy = authoritative.y - sample.y;
    const dz = authoritative.z - sample.z;
    this.error = Math.hypot(dx, dy, dz);

    if (this.error < DEADZONE) return;
    this.pendingX += dx;
    this.pendingY += dy;
    this.pendingZ += dz;
    this.corrections++;
  }

  /** Bleed queued error into the live body. Call once per simulated tick. */
  apply(world: SimWorld, localId: EntityId): void {
    const outstanding = Math.hypot(this.pendingX, this.pendingY, this.pendingZ);
    if (outstanding < DEADZONE) {
      this.pendingX = 0;
      this.pendingY = 0;
      this.pendingZ = 0;
      return;
    }

    if (outstanding > SNAP_DISTANCE) {
      // Way off — a respawn, an elimination, or a long stall. Smoothing this
      // would slide the player across the arena in full view.
      world.nudgeBody(localId, this.pendingX, this.pendingY, this.pendingZ);
      this.pendingX = 0;
      this.pendingY = 0;
      this.pendingZ = 0;
      this.snaps++;
      this.history.length = 0;
      return;
    }

    const dx = this.pendingX * CORRECTION_RATE;
    const dy = this.pendingY * CORRECTION_RATE;
    const dz = this.pendingZ * CORRECTION_RATE;
    world.nudgeBody(localId, dx, dy, dz);
    this.pendingX -= dx;
    this.pendingY -= dy;
    this.pendingZ -= dz;
  }

  /** Nearest recorded prediction at or before `tick`. */
  private sampleAt(tick: number): Sample | null {
    let best: Sample | null = null;
    for (const sample of this.history) {
      if (sample.tick > tick) break;
      best = sample;
    }
    // Only trust a close match; an ancient sample says nothing useful.
    if (best && tick - best.tick > 12) return null;
    return best;
  }
}
