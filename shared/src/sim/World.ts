import RAPIER from '@dimforge/rapier3d-compat';

import {
  ARENA_BODIES,
  ARENA_DUMMIES,
  PLAYER_MASS,
  PLAYER_RADIUS,
  type BodySpec,
} from './arena';
import { decideDummy, type DummyBehavior } from './Dummy';
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
  type Vec3,
} from './types';

export const TICK_RATE = 60;
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
  /**
   * Spawn the practice dummies. Turn off to measure one magnet in isolation —
   * with them present the grabber tows the player around, which quietly
   * contaminates any single-actor measurement.
   */
  dummies: boolean;
  /** Players to spawn up front. The server starts at 0 and adds on connect. */
  players: number;
}

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

const DEFAULT_OPTIONS: WorldOptions = { dummies: true, players: 1 };

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
  readonly velocity: Vec3;
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

  private readonly physics: RAPIER.World;
  private readonly bodies = new Map<EntityId, RAPIER.RigidBody>();
  /** Dynamic bodies only, in entity order — the per-tick hot loop. */
  private readonly dynamics: { entity: Entity; body: RAPIER.RigidBody }[] = [];
  private readonly dummies: {
    entity: Entity;
    body: RAPIER.RigidBody;
    behavior: DummyBehavior;
  }[] = [];
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
    this.physics = new RAPIER.World({ x: 0, y: TUNABLES.gravity, z: 0 });
    this.physics.timestep = TICK_DT;

    for (const spec of ARENA_BODIES) this.addBody(spec);
    for (let i = 0; i < opts.players; i++) this.addPlayer();

    if (!opts.dummies) return;
    for (const spec of ARENA_DUMMIES) {
      const entity = this.addBody(spec);
      this.dummies.push({
        entity,
        body: this.bodies.get(entity.id)!,
        behavior: spec.behavior,
      });
    }
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
  addPlayer(id?: EntityId): PlayerState {
    const spawn = PLAYER_SPAWNS[this.spawnCursor % PLAYER_SPAWNS.length]!;
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
        tint: 0,
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
      velocity: vec3(),
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

  /** Swap a dummy's behaviour mid-run. Used by the smoke checks as a control. */
  setDummyBehavior(id: EntityId, behavior: DummyBehavior): void {
    const dummy = this.dummies.find((d) => d.entity.id === id);
    if (dummy) dummy.behavior = behavior;
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
    for (const state of this.players.values()) {
      const body = this.bodies.get(state.id);
      if (!body) continue;
      const input = byPlayer.get(state.id) ?? emptyInput(this.tick);

      state.magnetAxis = input.magnet;
      state.aimX = input.aimX;
      state.aimZ = input.aimZ;

      this.applyMovement(state, body, input);
      this.applyMagnet(state.entity, body, input.aimX, input.aimZ, input.magnet);
    }

    // Dummies decide from the state at the top of the tick, so the order they
    // are evaluated in cannot change the outcome.
    //
    // They fire a focused beam at the player rather than a wide cone. That is
    // what makes each one a controlled experiment instead of a fourth source
    // of chaos: a cone this wide sprays every nearby body, and the source eats
    // a reaction from each, which flings the dummy off the map before you can
    // feel what it was demonstrating. Real players in Phase 4 use the same
    // call without the focus argument.
    // Dummies exist for the solo sandbox and always track the first player.
    const target = this.players.values().next().value;
    if (target) {
      const targetMagnet = byPlayer.get(target.id)?.magnet ?? 0;
      for (const dummy of this.dummies) {
        const command = decideDummy(
          dummy.behavior,
          this.tick,
          dummy.entity.pos,
          target.entity.pos,
          targetMagnet,
        );
        if (command.magnet === 0) continue;
        this.applyMagnet(
          dummy.entity,
          dummy.body,
          command.aimX,
          command.aimZ,
          command.magnet,
          target.id,
        );
      }
    }

    this.physics.step();
    this.readBack();
    this.respawnFallen();
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
   * Takes an explicit source rather than assuming the player, because dummies
   * (and, later, remote players) run exactly the same code. Two magnets acting
   * on each other with opposing polarity therefore cancel exactly, which is
   * what makes a tug-of-war a real stalemate instead of a slow win for whoever
   * the engine happens to evaluate first.
   */
  private applyMagnet(
    sourceEntity: Entity,
    sourceBody: RAPIER.RigidBody,
    aimX: number,
    aimZ: number,
    axis: number,
    focusTargetId: EntityId | null = null,
  ): void {
    if (axis === 0) return;
    const t = TUNABLES;

    const origin = sourceBody.translation();
    const cosHalf = Math.cos((t.coneHalfAngleDeg * Math.PI) / 180);

    for (const { entity, body } of this.dynamics) {
      if (!entity.magnetic || entity.id === sourceEntity.id) continue;
      if (focusTargetId !== null && entity.id !== focusTargetId) continue;

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

  private respawnFallen(): void {
    for (const { entity, body } of this.dynamics) {
      if (entity.pos.y > TUNABLES.killY) continue;

      const fallen = this.players.get(entity.id);
      if (fallen) {
        fallen.deaths++;
      } else if (entity.kind === 'dummy') {
        // No kill attribution yet: with one human it is unambiguous, and
        // crediting the right player needs last-touched tracking.
        const first = this.players.values().next().value;
        if (first) first.knockouts++;
      }
      this.respawn(entity, body);
    }
  }

  private respawn(entity: Entity, body: RAPIER.RigidBody): void {
    // Deterministic jitter so re-dropped balls do not stack into a tower.
    const isPlayer = this.players.has(entity.id);
    const jitterX = isPlayer ? 0 : this.rng.range(-1.2, 1.2);
    const jitterZ = isPlayer ? 0 : this.rng.range(-1.2, 1.2);
    const target = {
      x: entity.spawn.x + jitterX,
      y: entity.spawn.y + 2,
      z: entity.spawn.z + jitterZ,
    };

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
        : RAPIER.ColliderDesc.cuboid(spec.shape.hx, spec.shape.hy, spec.shape.hz);
    collider.setFriction(spec.friction).setRestitution(spec.restitution);
    // Rapier averages the two colliders' friction by default, which silently
    // averages away the player's deliberately-low grip against the platform's
    // high one (0.2 + 0.8 -> 0.5) and glues the player to the floor. Min means
    // each body's own friction is the one that governs.
    collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    if (!spec.static) collider.setMass(spec.mass);
    this.physics.createCollider(collider, body);

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
