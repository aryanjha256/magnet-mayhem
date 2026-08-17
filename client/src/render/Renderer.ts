import * as THREE from 'three';

import { PLATFORM_RADIUS } from '@magnet/shared/sim/arena';
import { TUNABLES } from '@magnet/shared/sim/tunables';
import type { Entity, EntityId, Vec3 } from '@magnet/shared/sim/types';
import type { SimWorld } from '@magnet/shared/sim/World';

import { arenaCameraDistance } from './framing';

const ATTRACT_COLOR = new THREE.Color(0x4fa8ff);
const REPEL_COLOR = new THREE.Color(0xff5a4f);

/**
 * The camera is static and frames the whole arena.
 *
 * It used to chase the player, which is wrong for a game this size: you cannot
 * see the opponent winding up a shove from off-screen, and being flung sends
 * the camera lurching after you exactly when you most need a stable read of the
 * disc. A fixed, pulled-back view keeps every player, every object and both
 * edges visible at once, and makes screen position map to world position
 * consistently — which is also what makes mouse aiming feel predictable.
 *
 * It does tighten as the arena closes, so the action never recedes into the
 * distance during the endgame.
 */
const CAMERA_LOOK_AT = new THREE.Vector3(0, 0, 0);

/**
 * Reads the sim and draws it. Owns no game state — every number it renders
 * comes from a SimWorld it was handed, interpolated between the last two ticks.
 */
export class Renderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly meshes = new Map<EntityId, THREE.Mesh>();

  private readonly tethers: THREE.LineSegments;
  private readonly tetherPositions: Float32Array;
  private readonly tetherColors: Float32Array;

  private readonly wedge: THREE.Mesh;
  private readonly wedgeMaterial: THREE.MeshBasicMaterial;
  private wedgeAngleDeg = -1;
  private wedgeRadius = -1;

  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly ndc = new THREE.Vector2();
  private readonly hit = new THREE.Vector3();

  /** Smoothed viewing distance, eased so the shrink does not pop the frame. */
  private cameraDistance = 0;
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    maxTethers: number,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x0a0c12);
    this.scene.fog = new THREE.Fog(0x0a0c12, 60, 130);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);

    this.buildLights();
    this.buildVoid();

    // One segment per magnet-target pair, rebuilt every frame. Without these
    // the forces are invisible and the chaos reads as random rather than
    // caused — doubly so now that several magnets can grab the same body.
    this.tetherPositions = new Float32Array(maxTethers * 6);
    this.tetherColors = new Float32Array(maxTethers * 6);
    const tetherGeom = new THREE.BufferGeometry();
    tetherGeom.setAttribute('position', new THREE.BufferAttribute(this.tetherPositions, 3));
    tetherGeom.setAttribute('color', new THREE.BufferAttribute(this.tetherColors, 3));
    this.tethers = new THREE.LineSegments(
      tetherGeom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }),
    );
    this.tethers.frustumCulled = false;
    this.scene.add(this.tethers);

    this.wedgeMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.wedge = new THREE.Mesh(new THREE.BufferGeometry(), this.wedgeMaterial);
    this.wedge.visible = false;
    this.wedge.renderOrder = 1;
    this.scene.add(this.wedge);

    this.resize();
  }

  /** Creates a mesh for every entity that does not have one yet. */
  syncEntities(world: SimWorld): void {
    for (const entity of world.entities) {
      if (this.meshes.has(entity.id)) continue;
      const mesh = new THREE.Mesh(geometryFor(entity), materialFor(entity));
      mesh.castShadow = !entity.static;
      mesh.receiveShadow = true;
      mesh.position.set(entity.pos.x, entity.pos.y, entity.pos.z);
      this.meshes.set(entity.id, mesh);
      this.scene.add(mesh);
    }
  }

  /**
   * @param alpha fraction of the way from the previous tick to the current one
   * @param dt    wall-clock seconds since the last frame, for camera damping
   */
  render(world: SimWorld, viewId: EntityId, alpha: number, dt: number): void {
    this.pruneMeshes(world);

    for (const entity of world.entities) {
      const mesh = this.meshes.get(entity.id);
      if (!mesh) continue;
      if (entity.static) continue;

      mesh.position.set(
        lerp(entity.prevPos.x, entity.pos.x, alpha),
        lerp(entity.prevPos.y, entity.pos.y, alpha),
        lerp(entity.prevPos.z, entity.pos.z, alpha),
      );
      this.qa.set(entity.prevRot.x, entity.prevRot.y, entity.prevRot.z, entity.prevRot.w);
      this.qb.set(entity.rot.x, entity.rot.y, entity.rot.z, entity.rot.w);
      mesh.quaternion.slerpQuaternions(this.qa, this.qb, alpha);
    }

    this.updateArena(world);
    this.updateElimination(world);
    this.updateTethers(world);

    this.updateCamera(dt);

    const viewMesh = this.meshes.get(viewId);
    if (viewMesh) this.updateWedge(world, viewId, viewMesh.position);

    this.renderer.render(this.scene, this.camera);
  }

  /** Where the cursor lands on the horizontal plane at height `y`. */
  screenToGround(ndcX: number, ndcY: number, y: number): Vec3 | null {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.groundPlane.constant = -y;
    const point = this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
    return point ? { x: point.x, y: point.y, z: point.z } : null;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Scale the platform mesh to match the collider the sim is shrinking. */
  private updateArena(world: SimWorld): void {
    const platform = world.entities.find((e) => e.kind === 'platform');
    if (!platform) return;
    const mesh = this.meshes.get(platform.id);
    if (!mesh || platform.shape.type !== 'cylinder') return;
    const scale = world.arenaRadius / platform.shape.radius;
    mesh.scale.set(scale, 1, scale);
  }

  /**
   * Hide anything the sim has taken out of play. Eliminated players and fallen
   * objects are parked below the kill plane, and drawing them leaves a field of
   * debris hanging in the void.
   */
  private updateElimination(world: SimWorld): void {
    for (const entity of world.entities) {
      if (entity.static) continue;
      const mesh = this.meshes.get(entity.id);
      if (!mesh) continue;
      const player = world.players.get(entity.id);
      mesh.visible = player ? player.alive : entity.pos.y > TUNABLES.killY;
    }
  }

  /** Drop meshes for entities that have left, e.g. a disconnected player. */
  private pruneMeshes(world: SimWorld): void {
    if (this.meshes.size === world.entities.length) return;
    const live = new Set(world.entities.map((e) => e.id));
    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.meshes.delete(id);
    }
  }

  private updateTethers(world: SimWorld): void {
    const capacity = this.tetherPositions.length / 6;
    let n = 0;

    for (const link of world.links) {
      if (n >= capacity) break;
      const from = this.meshes.get(link.sourceId);
      const to = this.meshes.get(link.targetId);
      if (!from || !to) continue;

      const color = link.force < 0 ? ATTRACT_COLOR : REPEL_COLOR;
      // Brightness tracks force magnitude, so you can see the falloff curve
      // doing its thing rather than having to trust the slider.
      const strength = Math.min(1, Math.abs(link.force) / TUNABLES.magnetStrength);
      const shade = 0.25 + 0.75 * strength;

      const i = n * 6;
      this.tetherPositions[i] = from.position.x;
      this.tetherPositions[i + 1] = from.position.y;
      this.tetherPositions[i + 2] = from.position.z;
      this.tetherPositions[i + 3] = to.position.x;
      this.tetherPositions[i + 4] = to.position.y;
      this.tetherPositions[i + 5] = to.position.z;
      for (let v = 0; v < 2; v++) {
        this.tetherColors[i + v * 3] = color.r * shade;
        this.tetherColors[i + v * 3 + 1] = color.g * shade;
        this.tetherColors[i + v * 3 + 2] = color.b * shade;
      }
      n++;
    }

    this.tethers.visible = n > 0;
    this.tethers.geometry.setDrawRange(0, n * 2);
    this.tethers.geometry.getAttribute('position').needsUpdate = true;
    this.tethers.geometry.getAttribute('color').needsUpdate = true;
  }

  private updateWedge(world: SimWorld, viewId: EntityId, origin: THREE.Vector3): void {
    const view = world.players.get(viewId);
    if (!view || view.magnetAxis === 0) {
      this.wedge.visible = false;
      return;
    }

    const { coneHalfAngleDeg, magnetRange } = TUNABLES;
    if (coneHalfAngleDeg !== this.wedgeAngleDeg || magnetRange !== this.wedgeRadius) {
      this.wedge.geometry.dispose();
      this.wedge.geometry = wedgeGeometry(magnetRange, (coneHalfAngleDeg * Math.PI) / 180);
      this.wedgeAngleDeg = coneHalfAngleDeg;
      this.wedgeRadius = magnetRange;
    }

    this.wedge.visible = true;
    this.wedge.position.set(origin.x, 0.03, origin.z);
    this.wedge.rotation.y = Math.atan2(view.aimX, view.aimZ);
    this.wedgeMaterial.color.copy(view.magnetAxis < 0 ? ATTRACT_COLOR : REPEL_COLOR);
    // Opacity tracks the analog trigger, so a half-squeeze looks like one.
    this.wedgeMaterial.opacity = 0.05 + 0.13 * Math.abs(view.magnetAxis);
  }

  private updateCamera(dt: number): void {
    // Framed to the arena's full size, never the current one: constant scale
    // beats a tight frame. Only a resize or the margin slider moves this.
    const target = arenaCameraDistance(
      this.camera.fov,
      this.camera.aspect,
      TUNABLES.cameraMargin,
    );

    // Eased only so dragging the margin slider or resizing the window does not
    // snap the view; in play this value is constant.
    this.cameraDistance =
      this.cameraDistance === 0
        ? target
        : this.cameraDistance + (target - this.cameraDistance) * (1 - Math.exp(-4 * dt));

    const tilt = (TUNABLES.cameraTiltDeg * Math.PI) / 180;
    this.camera.position.set(
      0,
      Math.sin(tilt) * this.cameraDistance,
      Math.cos(tilt) * this.cameraDistance,
    );
    this.camera.lookAt(CAMERA_LOOK_AT);
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x101018, 1.1));

    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(14, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const extent = PLATFORM_RADIUS + 6;
    const cam = sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 90;
    cam.updateProjectionMatrix();
    this.scene.add(sun);

    // Cool rim from the opposite side so silhouettes read against the void.
    const rim = new THREE.DirectionalLight(0x5577ff, 0.8);
    rim.position.set(-16, 8, -14);
    this.scene.add(rim);
  }

  private buildVoid(): void {
    // A grid far below, purely so falling has a sense of depth and speed.
    const grid = new THREE.GridHelper(160, 40, 0x1d2740, 0x141a2a);
    grid.position.y = -34;
    this.scene.add(grid);
  }
}

function geometryFor(entity: Entity): THREE.BufferGeometry {
  if (entity.shape.type === 'sphere') {
    return new THREE.SphereGeometry(entity.shape.radius, 28, 18);
  }
  if (entity.shape.type === 'cylinder') {
    const { radius, halfHeight } = entity.shape;
    return new THREE.CylinderGeometry(radius, radius, halfHeight * 2, 64);
  }
  return new THREE.BoxGeometry(entity.shape.hx * 2, entity.shape.hy * 2, entity.shape.hz * 2);
}

function materialFor(entity: Entity): THREE.Material {
  switch (entity.kind) {
    case 'platform':
      return new THREE.MeshStandardMaterial({ color: 0x232834, roughness: 0.95, metalness: 0.05 });
    case 'player': {
      // One hue per spawn slot. Everyone is the same silhouette, so colour is
      // the only thing separating you from three bots in a scrum.
      const tint = entity.tint || 0xffb347;
      return new THREE.MeshStandardMaterial({
        color: tint,
        emissive: tint,
        emissiveIntensity: 0.45,
        roughness: 0.4,
        metalness: 0.3,
      });
    }
    case 'crate':
      return new THREE.MeshStandardMaterial({ color: 0x54606f, roughness: 0.55, metalness: 0.75 });
    case 'ball':
    default: {
      // Heavier metal reads darker, so you can judge mass before touching it.
      const t = Math.min(1, entity.mass / 30);
      const color = new THREE.Color(0xb9cbdd).lerp(new THREE.Color(0x3d4a5c), t);
      return new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.9 });
    }
  }
}

/** Flat fan in the XZ plane, centred on +Z. Rotate with mesh.rotation.y. */
function wedgeGeometry(radius: number, halfAngle: number): THREE.BufferGeometry {
  const segments = Math.max(8, Math.ceil((halfAngle * 2) / (Math.PI / 64)));
  const positions = new Float32Array(segments * 9);
  for (let i = 0; i < segments; i++) {
    const a0 = -halfAngle + (2 * halfAngle * i) / segments;
    const a1 = -halfAngle + (2 * halfAngle * (i + 1)) / segments;
    const o = i * 9;
    positions[o] = 0;
    positions[o + 1] = 0;
    positions[o + 2] = 0;
    positions[o + 3] = Math.sin(a0) * radius;
    positions[o + 4] = 0;
    positions[o + 5] = Math.cos(a0) * radius;
    positions[o + 6] = Math.sin(a1) * radius;
    positions[o + 7] = 0;
    positions[o + 8] = Math.cos(a1) * radius;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geom;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
