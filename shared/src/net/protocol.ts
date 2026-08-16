import type { SimWorld } from '../sim/World';
import type { EntityId } from '../sim/types';

/**
 * The wire format. Lives in `shared/` so the client and the server can never
 * disagree about it.
 *
 * JSON for now, with short keys and flat number arrays. A full 16-body snapshot
 * is roughly 1 KB, so at 20 Hz that is ~20 KB/s per client — fine for localhost
 * and small rooms, and the flat-array shape is already the layout a binary
 * encoder would want when this needs quantizing.
 */
export const PROTOCOL_VERSION = 1;

/** How many sim ticks pass between broadcast snapshots. 60 / 3 = 20 Hz. */
export const TICKS_PER_SNAPSHOT = 3;

export interface InputMessage {
  t: 'input';
  /** Client's tick counter. Advisory for now; the server uses arrival order. */
  tick: number;
  mx: number;
  mz: number;
  ax: number;
  az: number;
  mag: number;
  dash: 0 | 1;
}

export type ClientMessage = InputMessage;

export interface WelcomeMessage {
  t: 'welcome';
  v: number;
  /** Which player entity belongs to this connection. */
  you: EntityId;
  tick: number;
  tickRate: number;
  ticksPerSnapshot: number;
  players: EntityId[];
}

export interface JoinMessage {
  t: 'join';
  id: EntityId;
}

export interface LeaveMessage {
  t: 'leave';
  id: EntityId;
}

export interface SnapshotMessage {
  t: 'snap';
  tick: number;
  /** [id, x, y, z, qx, qy, qz, qw] per dynamic body. */
  b: number[];
  /** [sourceId, targetId, force] per magnet link. */
  l: number[];
  /** [id, magnetAxis, aimX, aimZ, deaths, knockouts] per player. */
  p: number[];
}

export type ServerMessage = WelcomeMessage | JoinMessage | LeaveMessage | SnapshotMessage;

export const BODY_STRIDE = 8;
export const LINK_STRIDE = 3;
export const PLAYER_STRIDE = 6;

export function encodeSnapshot(world: SimWorld): SnapshotMessage {
  const b: number[] = [];
  for (const entity of world.entities) {
    if (entity.static) continue;
    b.push(
      entity.id,
      entity.pos.x,
      entity.pos.y,
      entity.pos.z,
      entity.rot.x,
      entity.rot.y,
      entity.rot.z,
      entity.rot.w,
    );
  }

  const l: number[] = [];
  for (const link of world.links) l.push(link.sourceId, link.targetId, link.force);

  const p: number[] = [];
  for (const state of world.players.values()) {
    p.push(state.id, state.magnetAxis, state.aimX, state.aimZ, state.deaths, state.knockouts);
  }

  return { t: 'snap', tick: world.tick, b, l, p };
}
