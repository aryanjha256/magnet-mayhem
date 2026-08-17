import { TUNABLES } from '@magnet/shared/sim/tunables';
import type { EntityId } from '@magnet/shared/sim/types';
import type { SimWorld } from '@magnet/shared/sim/World';

/**
 * Stage 2 prediction: the bodies you are magnetising.
 *
 * Stage 1 made your own movement instant, but the ball you aim at was still
 * where it *was* — which matters here more than in most games, because
 * manipulating objects is the entire mechanic.
 *
 * The idea is ownership. While your magnet is acting on a body, the client
 * owns it and the server's version is ignored. When you let go, ownership
 * fades out over a few ticks rather than snapping, so the body drifts back to
 * server truth instead of teleporting.
 *
 * Two guardrails, because getting this wrong feels *worse* than plain lag:
 *
 *   - Never own another player. They are driven by inputs we cannot see, so a
 *     prediction would diverge immediately and rubber-band.
 *   - Abandon on divergence. If the server has a body somewhere far from where
 *     we put it, somebody else is pulling it too and we were simply wrong.
 */

/** Weight below which a body is considered fully server-owned again. */
const EPSILON = 0.01;

export class ObjectPredictor {
  /** Bodies whose server position we are currently overriding, 1 -> 0. */
  private readonly weights = new Map<EntityId, number>();
  private readonly claimed = new Set<EntityId>();

  owned = 0;
  fading = 0;
  abandons = 0;

  get enabled(): boolean {
    return TUNABLES.predictObjects > 0.5;
  }

  /**
   * Call straight after stepping. `world.links` is the local sim's own record
   * of what our magnet just touched, which is exactly the claim set — no
   * separate cone maths that could disagree with the physics.
   */
  update(world: SimWorld, localId: EntityId): void {
    if (!this.enabled) {
      this.weights.clear();
      this.owned = 0;
      this.fading = 0;
      return;
    }

    this.claimed.clear();
    for (const link of world.links) {
      if (link.sourceId !== localId) continue;
      // Never another player: their input is unknowable, so predicting them
      // guarantees divergence.
      if (world.players.has(link.targetId)) continue;
      this.claimed.add(link.targetId);
    }

    for (const id of this.claimed) this.weights.set(id, 1);

    const decay = 1 / Math.max(1, TUNABLES.objectBlendTicks);
    for (const [id, weight] of [...this.weights]) {
      if (this.claimed.has(id)) continue;
      const next = weight - decay;
      if (next <= EPSILON) this.weights.delete(id);
      else this.weights.set(id, next);
    }

    this.owned = this.claimed.size;
    this.fading = this.weights.size - this.claimed.size;
  }

  /** 1 = fully local, 0 = fully server, between = blending home. */
  weightFor(id: EntityId): number {
    return this.weights.get(id) ?? 0;
  }

  /** The server disagrees too strongly to be reconciled — give the body back. */
  abandon(id: EntityId): void {
    if (this.weights.delete(id)) this.abandons++;
  }

  reset(): void {
    this.weights.clear();
    this.claimed.clear();
    this.owned = 0;
    this.fading = 0;
  }
}
