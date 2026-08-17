import RAPIER from '@dimforge/rapier3d-compat';

import {
  ARENA_BODIES,
  PLATFORM_RADIUS,
  PLAYER_MASS,
  PLAYER_RADIUS,
  type BodySpec,
} from './arena';
import type { MatchState } from './Match';
import { emptyInput, type Input } from './input';
import { falloff, inCone } from './magnet';
import { Rng } from './rng';
import { TUNABLES } from './tunables';
import {
  quatIdentity,
  vec3,
  type Entity,
  type EntityId,
  type MagnetLink,
  type Quat,
  type Vec3,
} from './types';

export const TICK_RATE = 60;
/** Fixed phase lengths. Only the round cap and shrink curve are tunable. */
const COUNTDOWN_SECONDS = 2.5;
const ROUND_OVER_SECONDS = 3;
const MATCH_OVER_SECONDS = 6;
export const TICK_DT = 1 / TICK_RATE;

let rapierReady = false;

/** Must be awaited once before constructing a SimWorld. */
export async function initSim(): Promise<void> {
  if (rapierReady) return;
  await RAPIER.init();
  rapierReady = true;
}

/** In-place filter; keeps the array identity so `readonly` fields stay valid. */
function removeWhere<T>(list: T[], predicate: (item: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (predicate(list[i]!)) list.splice(i, 1);
  }
}

export interface WorldOptions {
  /** Human players to spawn up front. A server starts at 0 and adds on connect. */
  players: number;
  /**
   * Bot players to spawn. Set 0 to measure one magnet in isolation — bots move
   * and shove, which quietly contaminates any single-actor measurement.
   */
  bots: number;
  /**
   * Run rounds, elimination and the shrinking arena. Off gives the endless
   * sandbox, which is what the isolated physics measurements need.
   */
  match: boolean;
  /**
   * Owns the outcome of a fall. A predicting client sets this false: the server
   * decides who respawns and who is eliminated, and a client quietly respawning
   * its own player fights that every time it happens.
   */
  authoritative: boolean;
}

/** One colour per spawn slot, so players and bots are told apart at a glance. */
const PLAYER_TINTS: readonly number[] = [
  0xffb347, 0x6fd3ff, 0xc678dd, 0x56c98a, 0xff7a9c, 0xffe066, 0x8f9bb3, 0xff8f5a,
];

/** Spawn ring, so players never start on top of each other or on a ball. */
const PLAYER_SPAWNS: readonly Vec3[] = [
  { x: 0, y: 2, z: 0 },
  { x: 2.5, y: 2, z: 2.5 },
  { x: -2.5, y: 2, z: 2.5 },
  { x: 2.5, y: 2, z: -1.5 },
  { x: -1.5, y: 2, z: -2.5 },
  { x: 3.5, y: 2, z: 0.5 },
  { x: -3.5, y: 2, z: -0.5 },
  { x: 1.5, y: 2, z: 3.5 },
];

const DEFAULT_OPTIONS: WorldOptions = { players: 1, bots: 2, match: true, authoritative: true };

/** Per-player state that used to be fields on the world itself. */
export interface PlayerState {
  readonly id: EntityId;
  readonly entity: Entity;
  /** Mirrors the last input, for rendering this player's magnet cone. */
  magnetAxis: number;
  aimX: number;
  aimZ: number;
  dashCooldown: number;
  deaths: number;
  /** Other players and dummies this one knocked into the void. */
  knockouts: number;
  /** False once eliminated. Stays false until the next round starts. */
  alive: boolean;
  roundWins: number;
  readonly velocity: Vec3;
  /** Driven by `BotDirector` rather than a socket. The sim treats both alike. */
  readonly isBot: boolean;
}

/**
 * The authoritative game state.
 *
 * Advances in fixed `TICK_DT` steps and consumes nothing but `Input` structs.
 * It knows nothing about Three.js, the DOM, sockets, or wall-clock time — `tick`
 * is the only clock. That is what lets the server run this file unchanged.
 *
 * There is no "local" player here. The server has none, so the concept lives in
 * the client instead: whoever is rendering picks a viewpoint id.
 */
export class SimWorld {
  tick = 0;
  readonly entities: Entity[] = [];
  readonly players = new Map<EntityId, PlayerState>();

  /** Every magnet-target pair active this tick. Rebuilt from scratch each step. */
  readonly links: MagnetLink[] = [];

  readonly match: MatchState = {
    phase: 'countdown',
    timer: 0,
    round: 1,
    elapsed: 0,
    lastWinner: 0,
    champion: 0,
    arenaRadius: PLATFORM_RADIUS,
    startedWith: 0,
  };

  private readonly matchEnabled: boolean;
  private readonly authoritative: boolean;
  private platformCollider: RAPIER.Collider | null = null;

  private readonly physics: RAPIER.World;
  private readonly bodies = new Map<EntityId, RAPIER.RigidBody>();
  /** Dynamic bodies only, in entity order — the per-tick hot loop. */
  private readonly dynamics: { entity: Entity; body: RAPIER.RigidBody }[] = [];
  private readonly rng: Rng;
  private nextId = 1;
  private spawnCursor = 0;
  /** Reused so the single-player path does not allocate a Map every tick. */
  private readonly soloInputs = new Map<EntityId, Input>();

  constructor(seed = 0x5eed, options: Partial<WorldOptions> = {}) {
    const opts: WorldOptions = { ...DEFAULT_OPTIONS, ...options };
    if (!rapierReady) {
      throw new Error('initSim() must be awaited before constructing SimWorld');
    }
    this.rng = new Rng(seed);
    this.matchEnabled = opts.match;
    this.authoritative = opts.authoritative;
    this.physics = new RAPIER.World({ x: 0, y: TUNABLES.gravity, z: 0 });
    this.physics.timestep = TICK_DT;

    for (const spec of ARENA_BODIES) this.addBody(spec);
    for (let i = 0; i < opts.players; i++) this.addPlayer();
    for (let i = 0; i < opts.bots; i++) this.addPlayer(undefined, true);
    if (this.matchEnabled) this.beginRound(1);
  }

  /** Current platform radius. Bots steer by this, not by a constant. */
  get arenaRadius(): number {
    return this.match.arenaRadius;
  }

  get alivePlayers(): PlayerState[] {
    return [...this.players.values()].filter((p) => p.alive);
  }

  /**
   * First player. A convenience for the single-player sandbox and the smoke
   * checks; multi-player callers should address players by id.
   */
  get playerId(): EntityId {
    return this.players.keys().next().value ?? 0;
  }

  /** First player's state. Same single-player convenience as `playerId`. */
  get me(): PlayerState {
    const first = this.players.values().next().value;
    if (!first) throw new Error('world has no players');
    return first;
  }

  get player(): Entity {
    return this.me.entity;
  }

  /**
   * Add a player mid-run. `id` lets a client mirror ids the server assigned;
   * without it the world allocates its own.
   */
  addPlayer(id?: EntityId, isBot = false): PlayerState {
    const index = this.spawnCursor % PLAYER_SPAWNS.length;
    const spawn = PLAYER_SPAWNS[index]!;
    this.spawnCursor++;

    const entity = this.addBody(
      {
        kind: 'player',
        shape: { type: 'sphere', radius: PLAYER_RADIUS },
        mass: PLAYER_MASS,
        spawn,
        magnetic: true,
        static: false,
        // Low, on purpose: the player slides. With realistic footing, friction
        // eats the equal-and-opposite reaction and self-launching stops working.
        friction: 0.2,
        restitution: 0.1,
        lockRotations: true,
        tint: PLAYER_TINTS[index % PLAYER_TINTS.length]!,
      },
      id,
    );

    const state: PlayerState = {
      id: entity.id,
      entity,
      magnetAxis: 0,
      aimX: 0,
      aimZ: 1,
      dashCooldown: 0,
      deaths: 0,
      knockouts: 0,
      alive: true,
      roundWins: 0,
      velocity: vec3(),
      isBot,
    };
    this.players.set(entity.id, state);
    return state;
  }

  /** Remove a disconnected player and its body. */
  removePlayer(id: EntityId): void {
    const state = this.players.get(id);
    if (!state) return;
    const body = this.bodies.get(id);
    if (body) this.physics.removeRigidBody(body);

    this.players.delete(id);
    this.bodies.delete(id);
    removeWhere(this.entities, (e) => e.id === id);
    removeWhere(this.dynamics, (d) => d.entity.id === id);
  }

  /**
   * Overwrite a body from an authoritative source — i.e. a server snapshot.
   *
   * A predicting client simulates everything but only *owns* its own player;
   * every other body is stamped back to what the server said before the next
   * step, so local physics never drifts away from the room.
   */
  setBodyState(id: EntityId, pos: Vec3, rot: Quat, linvel?: Vec3): void {
    const body = this.bodies.get(id);
    const entity = this.entities.find((e) => e.id === id);
    if (!body || !entity) return;

    body.setTranslation(pos, false);
    body.setRotation(rot, false);
    // Velocity matters as much as position: a body teleported each tick with
    // zero velocity collides like a wall instead of like something moving.
    body.setLinvel(linvel ?? { x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);

    entity.pos.x = pos.x;
    entity.pos.y = pos.y;
    entity.pos.z = pos.z;
    entity.rot.x = rot.x;
    entity.rot.y = rot.y;
    entity.rot.z = rot.z;
    entity.rot.w = rot.w;
    entity.prevPos.x = pos.x;
    entity.prevPos.y = pos.y;
    entity.prevPos.z = pos.z;
    entity.prevRot.x = rot.x;
    entity.prevRot.y = rot.y;
    entity.prevRot.z = rot.z;
    entity.prevRot.w = rot.w;
  }

  /** Nudge the local player toward where the server says it should be. */
  nudgeBody(id: EntityId, dx: number, dy: number, dz: number): void {
    const body = this.bodies.get(id);
    if (!body) return;
    const p = body.translation();
    body.setTranslation({ x: p.x + dx, y: p.y + dy, z: p.z + dz }, false);
  }

  /**
   * Mirror the server's arena size. Without this a predicting client walks on a
   * full-size disc while the server has already closed it in, and every step
   * near the rim mispredicts.
   */
  setArenaRadius(radius: number): void {
    this.match.arenaRadius = radius;
    this.applyArenaRadius(radius);
  }

  /** Enable or disable a body, mirroring server-side elimination. */
  setBodyEnabled(id: EntityId, enabled: boolean): void {
    this.bodies.get(id)?.setEnabled(enabled);
  }

  /**
   * Advance exactly one tick. The only entry point.
   *
   * Accepts a bare Input for the single-player sandbox, or a map of
   * player id -> Input for a room.
   */
  step(inputs: Input | ReadonlyMap<EntityId, Input>): void {
    this.tick++;
    const t = TUNABLES;

    let byPlayer: ReadonlyMap<EntityId, Input>;
    if (inputs instanceof Map) {
      byPlayer = inputs;
    } else {
      this.soloInputs.clear();
      this.soloInputs.set(this.playerId, inputs as Input);
      byPlayer = this.soloInputs;
    }

    this.physics.gravity.y = t.gravity;
    this.physics.timestep = TICK_DT;

    // Rapier forces persist until reset, so every tick starts from zero.
    for (const { entity, body } of this.dynamics) {
      entity.prevPos.x = entity.pos.x;
      entity.prevPos.y = entity.pos.y;
      entity.prevPos.z = entity.pos.z;
      entity.prevRot.x = entity.rot.x;
      entity.prevRot.y = entity.rot.y;
      entity.prevRot.z = entity.rot.z;
      entity.prevRot.w = entity.rot.w;
      body.resetForces(false);
      body.setLinearDamping(t.linearDamping);
    }
    this.links.length = 0;

    // Every player is resolved against the same start-of-tick state, so the
    // order they are stored in cannot change the outcome — which matters once
    // a server is replaying inputs that arrived in an arbitrary order.
    // Nobody acts outside a live round: a countdown you can shove through is
    // not a countdown, and the eliminated should not keep playing.
    const frozen = this.matchEnabled && this.match.phase !== 'playing';

    for (const state of this.players.values()) {
      const body = this.bodies.get(state.id);
      if (!body || !state.alive) continue;
      const input = frozen
        ? emptyInput(this.tick)
        : (byPlayer.get(state.id) ?? emptyInput(this.tick));

      state.magnetAxis = input.magnet;
      state.aimX = input.aimX;
      state.aimZ = input.aimZ;

      this.applyMovement(state, body, input);
      this.applyMagnet(state.entity, body, input.aimX, input.aimZ, input.magnet);
    }

    this.physics.step();
    this.readBack();
    this.respawnFallen();
    if (this.matchEnabled) this.updateMatch();
  }

  private applyMovement(state: PlayerState, player: RAPIER.RigidBody, input: Input): void {
    const t = TUNABLES;

    if (state.dashCooldown > 0) state.dashCooldown--;

    const moveLen = Math.hypot(input.moveX, input.moveZ);
    const dirX = moveLen > 1e-4 ? input.moveX / moveLen : input.aimX;
    const dirZ = moveLen > 1e-4 ? input.moveZ / moveLen : input.aimZ;
    // Analog sticks report partial deflection and should walk slower for it.
    // Clamped at 1 so a keyboard diagonal (length ~1.41) is not faster than a
    // cardinal.
    const throttle = Math.min(moveLen, 1);

    if (moveLen > 1e-4) {
      const v = player.linvel();
      // Throttle scales the speed cap, not the force. Scaling the force instead
      // is the obvious move and it feels terrible: friction is constant, so it
      // eats most of a reduced force and the bottom third of stick travel does
      // almost nothing. Full force against a lower cap stays linear.
      // Walking is capped, magnet launches are not — being flung is meant to be
      // the fast way to cross the arena.
      if (Math.hypot(v.x, v.z) < t.maxSpeed * throttle) {
        player.addForce({ x: dirX * t.moveForce, y: 0, z: dirZ * t.moveForce }, true);
      }
    }

    if (input.dash && state.dashCooldown === 0 && t.dashImpulse > 0) {
      player.applyImpulse({ x: dirX * t.dashImpulse, y: 0, z: dirZ * t.dashImpulse }, true);
      state.dashCooldown = t.dashCooldownTicks;
    }
  }

  /**
   * Apply one magnet's pull to everything in its cone.
   *
   * Takes an explicit source rather than assuming a particular player, because
   * every actor — human, bot, remote — runs exactly this code. Two magnets
   * acting on each other with opposing polarity therefore cancel exactly, which
   * is what makes a tug-of-war a real stalemate rather than a slow win for
   * whoever the engine happens to evaluate first.
   */
  private applyMagnet(
    sourceEntity: Entity,
    sourceBody: RAPIER.RigidBody,
    aimX: number,
    aimZ: number,
    axis: number,
  ): void {
    if (axis === 0) return;
    const t = TUNABLES;

    const origin = sourceBody.translation();
    const cosHalf = Math.cos((t.coneHalfAngleDeg * Math.PI) / 180);

    for (const { entity, body } of this.dynamics) {
      if (!entity.magnetic || entity.id === sourceEntity.id) continue;

      const p = body.translation();
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;
      const dz = p.z - origin.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > t.magnetRange || dist < 1e-4) continue;
      if (!inCone(dx, dz, aimX, aimZ, cosHalf)) continue;

      const k = falloff(t.falloffMode, dist, t.magnetRange, t.falloffExponent, t.minDistance);
      if (k <= 0) continue;

      // +1 (repel) pushes along `dir`, -1 (attract) pulls back along it.
      const magnitude = t.magnetStrength * k * axis;
      const fx = (dx / dist) * magnitude;
      const fy = (dy / dist) * magnitude;
      const fz = (dz / dist) * magnitude;

      body.addForce({ x: fx, y: fy, z: fz }, true);

      // Equal and opposite. a = F/m, so the mass ratio decides who moves:
      // this one line is both the weapon and the grappling hook.
      const r = t.reactionScale;
      if (r !== 0) {
        sourceBody.addForce({ x: -fx * r, y: -fy * r, z: -fz * r }, true);
      }

      this.links.push({ sourceId: sourceEntity.id, targetId: entity.id, force: magnitude });
    }
  }

  private readBack(): void {
    for (const { entity, body } of this.dynamics) {
      const p = body.translation();
      const q = body.rotation();
      entity.pos.x = p.x;
      entity.pos.y = p.y;
      entity.pos.z = p.z;
      entity.rot.x = q.x;
      entity.rot.y = q.y;
      entity.rot.z = q.z;
      entity.rot.w = q.w;
    }
    for (const state of this.players.values()) {
      const v = this.bodies.get(state.id)?.linvel();
      if (!v) continue;
      state.velocity.x = v.x;
      state.velocity.y = v.y;
      state.velocity.z = v.z;
    }
  }

  /** Reset the arena and everyone in it, then run the countdown. */
  private beginRound(round: number): void {
    const m = this.match;
    m.phase = 'countdown';
    m.round = round;
    m.timer = Math.round(COUNTDOWN_SECONDS * TICK_RATE);
    m.elapsed = 0;
    m.lastWinner = 0;
    m.arenaRadius = PLATFORM_RADIUS;
    this.applyArenaRadius(PLATFORM_RADIUS);

    for (const { entity, body } of this.dynamics) {
      const player = this.players.get(entity.id);
      if (player) player.alive = true;
      body.setEnabled(true);
      this.respawn(entity, body);
    }
    m.startedWith = this.players.size;
  }

  private updateMatch(): void {
    const m = this.match;
    if (m.timer > 0) m.timer--;

    switch (m.phase) {
      case 'countdown':
        if (m.timer <= 0) {
          m.phase = 'playing';
          m.timer = Math.round(TUNABLES.roundSeconds * TICK_RATE);
          m.elapsed = 0;
        }
        break;

      case 'playing': {
        m.elapsed++;
        this.updateShrink();

        // A server room is empty when its first round begins, so the count has
        // to track joins or a round could never be won.
        if (this.players.size > m.startedWith) m.startedWith = this.players.size;

        const alive = this.alivePlayers;
        // A solo world never wins by being last standing, or the tuning
        // sandbox would end its round the instant it started.
        const decided = m.startedWith >= 2 && alive.length <= 1;
        if (decided || m.timer <= 0) this.endRound(alive);
        break;
      }

      case 'roundOver':
        if (m.timer <= 0) {
          const champion = [...this.players.values()].find(
            (p) => p.roundWins >= TUNABLES.roundsToWin,
          );
          if (champion) {
            m.champion = champion.id;
            m.phase = 'matchOver';
            m.timer = Math.round(MATCH_OVER_SECONDS * TICK_RATE);
          } else {
            this.beginRound(m.round + 1);
          }
        }
        break;

      case 'matchOver':
        if (m.timer <= 0) {
          for (const p of this.players.values()) p.roundWins = 0;
          m.champion = 0;
          this.beginRound(1);
        }
        break;
    }
  }

  private endRound(alive: PlayerState[]): void {
    const m = this.match;
    // On a timeout with several survivors the player nearest the middle takes
    // it — arbitrary, but deterministic and never a stalemate.
    let winner: PlayerState | null = null;
    if (alive.length === 1) {
      winner = alive[0]!;
    } else if (alive.length > 1) {
      let best = Infinity;
      for (const p of alive) {
        const d = Math.hypot(p.entity.pos.x, p.entity.pos.z);
        if (d < best) {
          best = d;
          winner = p;
        }
      }
    }

    if (winner) {
      winner.roundWins++;
      m.lastWinner = winner.id;
    }
    m.phase = 'roundOver';
    m.timer = Math.round(ROUND_OVER_SECONDS * TICK_RATE);
  }

  /** Close the platform in, so a cautious pair cannot circle forever. */
  private updateShrink(): void {
    const grace = TUNABLES.shrinkGraceSeconds * TICK_RATE;
    const span = Math.max(1, TUNABLES.shrinkSeconds * TICK_RATE);
    const progress = Math.min(1, Math.max(0, (this.match.elapsed - grace) / span));
    const radius = PLATFORM_RADIUS + (TUNABLES.arenaMinRadius - PLATFORM_RADIUS) * progress;

    if (Math.abs(radius - this.match.arenaRadius) < 1e-4) return;
    this.match.arenaRadius = radius;
    this.applyArenaRadius(radius);
  }

  private applyArenaRadius(radius: number): void {
    this.platformCollider?.setRadius(radius);
  }

  private respawnFallen(): void {
    // A mirror never decides a fall; the snapshot will tell it what happened.
    if (!this.authoritative) return;
    const eliminating = this.matchEnabled && this.match.phase === 'playing';

    for (const { entity, body } of this.dynamics) {
      // Already out. Its body is parked below the arena, so without this the
      // death counter would tick up every frame for the rest of the round.
      if (!body.isEnabled()) continue;
      if (entity.pos.y > TUNABLES.killY) continue;

      const fallen = this.players.get(entity.id);
      if (fallen) fallen.deaths++;

      if (eliminating) {
        // Out for the rest of the round — objects as well as players. Objects
        // used to respawn, but every spawn point sits near the original 9m rim,
        // so once the arena closed past them they fell, respawned over the
        // void, and fell again, littering the sky with debris.
        if (fallen) fallen.alive = false;
        body.setEnabled(false);
        continue;
      }
      this.respawn(entity, body);
    }
  }

  private respawn(entity: Entity, body: RAPIER.RigidBody): void {
    const isPlayer = this.players.has(entity.id);

    // Players come back at whichever spawn slot is furthest from everyone
    // else. A fixed slot drops you straight back into the scrum that just
    // killed you, and chain deaths read as the game being unfair.
    const origin = isPlayer ? this.safestSpawn(entity.id) : entity.spawn;

    // Deterministic jitter so re-dropped balls do not stack into a tower.
    const jitterX = isPlayer ? 0 : this.rng.range(-1.2, 1.2);
    const jitterZ = isPlayer ? 0 : this.rng.range(-1.2, 1.2);
    // Pull the spawn inside the current disc. Every object's spawn sits near
    // the original 9m rim, so once the arena closes past them they would fall,
    // respawn over the void, and fall again — forever.
    const target = this.insideArena(origin.x + jitterX, origin.y + 2, origin.z + jitterZ);

    body.setTranslation(target, true);
    body.setRotation(quatIdentity(), true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.resetForces(false);

    entity.pos = { ...target };
    entity.rot = quatIdentity();
    // Snap history too, or the renderer lerps across the whole teleport.
    entity.prevPos = { ...target };
    entity.prevRot = quatIdentity();
  }

  /** Scale a spawn point back inside the arena, keeping a little margin. */
  private insideArena(x: number, y: number, z: number): Vec3 {
    const limit = this.match.arenaRadius * 0.75;
    const radius = Math.hypot(x, z);
    if (radius <= limit || radius < 1e-4) return { x, y, z };
    const scale = limit / radius;
    return { x: x * scale, y, z: z * scale };
  }

  /** The spawn slot with the largest distance to the nearest other player. */
  private safestSpawn(exceptId: EntityId): Vec3 {
    let best = PLAYER_SPAWNS[0]!;
    let bestClearance = -1;

    for (const slot of PLAYER_SPAWNS) {
      let nearest = Infinity;
      for (const other of this.players.values()) {
        if (other.id === exceptId) continue;
        const d = Math.hypot(other.entity.pos.x - slot.x, other.entity.pos.z - slot.z);
        if (d < nearest) nearest = d;
      }
      if (nearest > bestClearance) {
        bestClearance = nearest;
        best = slot;
      }
    }
    return best;
  }

  private addBody(spec: BodySpec, forcedId?: EntityId): Entity {
    const desc = spec.static
      ? RAPIER.RigidBodyDesc.fixed()
      : RAPIER.RigidBodyDesc.dynamic()
          .setLinearDamping(TUNABLES.linearDamping)
          .setAngularDamping(0.4)
          .setCcdEnabled(true);
    desc.setTranslation(spec.spawn.x, spec.spawn.y, spec.spawn.z);
    if (spec.lockRotations) desc.lockRotations();

    const body = this.physics.createRigidBody(desc);

    const collider =
      spec.shape.type === 'sphere'
        ? RAPIER.ColliderDesc.ball(spec.shape.radius)
        : spec.shape.type === 'cylinder'
          ? RAPIER.ColliderDesc.cylinder(spec.shape.halfHeight, spec.shape.radius)
          : RAPIER.ColliderDesc.cuboid(spec.shape.hx, spec.shape.hy, spec.shape.hz);
    collider.setFriction(spec.friction).setRestitution(spec.restitution);
    // Rapier averages the two colliders' friction by default, which silently
    // averages away the player's deliberately-low grip against the platform's
    // high one (0.2 + 0.8 -> 0.5) and glues the player to the floor. Min means
    // each body's own friction is the one that governs.
    collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    if (!spec.static) collider.setMass(spec.mass);
    const created = this.physics.createCollider(collider, body);
    if (spec.kind === 'platform') this.platformCollider = created;

    // A client mirroring a server room must reuse the server's ids, or the two
    // sides disagree about which body a snapshot is describing.
    const id = forcedId ?? this.nextId;
    this.nextId = Math.max(this.nextId, id) + 1;

    const entity: Entity = {
      id,
      kind: spec.kind,
      shape: spec.shape,
      magnetic: spec.magnetic,
      static: spec.static,
      spawn: { ...spec.spawn },
      mass: spec.static ? 0 : body.mass(),
      pos: { ...spec.spawn },
      rot: quatIdentity(),
      prevPos: { ...spec.spawn },
      prevRot: quatIdentity(),
      tint: spec.tint,
    };

    this.entities.push(entity);
    this.bodies.set(entity.id, body);
    if (!spec.static) this.dynamics.push({ entity, body });
    return entity;
  }
}
