import { emptyInput, type Input } from '@magnet/shared/sim/input';
import type { EntityId } from '@magnet/shared/sim/types';
import { SimWorld, TICK_RATE } from '@magnet/shared/sim/World';
import {
  encodeSnapshot,
  PROTOCOL_VERSION,
  TICKS_PER_SNAPSHOT,
  type ClientMessage,
  type ServerMessage,
} from '@magnet/shared/net/protocol';

export const MAX_PLAYERS = 8;

export interface Client {
  send(message: ServerMessage): void;
  close(): void;
}

/**
 * One authoritative game.
 *
 * The server owns the simulation outright: clients send intent, the room
 * decides. Note there is no physics code here at all — it runs the exact
 * `SimWorld` the single-player sandbox runs, which is the whole payoff of
 * keeping `shared/sim` free of browser imports.
 */
export class Room {
  private readonly world: SimWorld;
  private readonly clients = new Map<EntityId, Client>();
  /**
   * Latest input per player. Holding the most recent one rather than a queue
   * means a dropped packet repeats the previous intent instead of stalling —
   * the right failure mode for a held button.
   */
  private readonly inputs = new Map<EntityId, Input>();

  constructor() {
    // No dummies online: they are a solo practice tool, and they would fight
    // whichever player happened to join first.
    this.world = new SimWorld(0x5eed, { dummies: false, players: 0 });
  }

  get playerCount(): number {
    return this.clients.size;
  }

  get isFull(): boolean {
    return this.clients.size >= MAX_PLAYERS;
  }

  join(client: Client): EntityId {
    const state = this.world.addPlayer();
    this.clients.set(state.id, client);
    this.inputs.set(state.id, emptyInput(this.world.tick));

    client.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      you: state.id,
      tick: this.world.tick,
      tickRate: TICK_RATE,
      ticksPerSnapshot: TICKS_PER_SNAPSHOT,
      players: [...this.world.players.keys()],
    });
    this.broadcast({ t: 'join', id: state.id }, state.id);
    return state.id;
  }

  leave(id: EntityId): void {
    if (!this.clients.delete(id)) return;
    this.inputs.delete(id);
    this.world.removePlayer(id);
    this.broadcast({ t: 'leave', id });
  }

  receive(id: EntityId, message: ClientMessage): void {
    if (message.t !== 'input') return;
    if (!this.clients.has(id)) return;
    // Never trust a client's numbers: a hand-written socket could send NaN or
    // a magnet axis of 500 and drive the whole room's physics through it.
    this.inputs.set(id, {
      tick: this.world.tick,
      moveX: clamp(message.mx, -1, 1),
      moveZ: clamp(message.mz, -1, 1),
      aimX: clamp(message.ax, -1, 1),
      aimZ: clamp(message.az, -1, 1),
      magnet: clamp(message.mag, -1, 1),
      dash: message.dash === 1,
    });
  }

  /** One fixed sim step, plus a snapshot on the broadcast cadence. */
  tick(): void {
    this.world.step(this.inputs);

    // A dash is an edge, not a state: without clearing it here a single press
    // would fire on every tick until the next packet arrived.
    for (const input of this.inputs.values()) input.dash = false;

    if (this.world.tick % TICKS_PER_SNAPSHOT === 0) {
      this.broadcast(encodeSnapshot(this.world));
    }
  }

  private broadcast(message: ServerMessage, except?: EntityId): void {
    for (const [id, client] of this.clients) {
      if (id === except) continue;
      client.send(message);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}
