import { Hud } from './debug/Hud';
import { mountTuner } from './debug/Tuner';
import { buildInput } from './input/buildInput';
import { GamepadSource } from './input/GamepadSource';
import { InputSource } from './input/InputSource';
import { Connection } from './net/Connection';
import { ObjectPredictor } from './net/ObjectPredictor';
import { Predictor } from './net/Predictor';
import { SnapshotBuffer } from './net/SnapshotBuffer';
import { Renderer } from './render/Renderer';
import { BotDirector } from '@magnet/shared/sim/Bot';
import type { Input } from '@magnet/shared/sim/input';
import { BODY_STRIDE } from '@magnet/shared/net/protocol';
import type { EntityId } from '@magnet/shared/sim/types';
import { initSim, SimWorld, TICK_DT } from '@magnet/shared/sim/World';

/** Never simulate more than this many ticks in one frame; drop the rest. */
const MAX_CATCHUP_STEPS = 5;

/** The local player's authoritative position out of a snapshot, if present. */
function readPlayerPos(
  snapshot: { b: number[] },
  id: EntityId,
): { x: number; y: number; z: number } | null {
  for (let i = 0; i < snapshot.b.length; i += BODY_STRIDE) {
    if (snapshot.b[i] === id) {
      return { x: snapshot.b[i + 1]!, y: snapshot.b[i + 2]!, z: snapshot.b[i + 3]! };
    }
  }
  return null;
}

function requireEl<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
}

/** `?online` joins the local server; `?server=ws://host:port` picks another. */
function serverUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const explicit = params.get('server');
  if (explicit) return explicit;
  if (!params.has('online')) return null;
  return `ws://${location.hostname}:8080`;
}

async function main(): Promise<void> {
  await initSim();

  const url = serverUrl();
  const online = url !== null;

  // Online, the client runs no physics at all: the world is a *view*, its
  // transforms overwritten by snapshots. Same class either way, so the renderer
  // and HUD cannot tell the difference.
  // `match: false` online: the server owns rounds, the countdown and the
  // shrink. A client running its own would freeze input during a countdown the
  // server is not having, and fight it over the arena radius.
  let world = online
    ? new SimWorld(0x5eed, { players: 0, bots: 0, match: false, authoritative: false })
    : new SimWorld();

  const canvas = requireEl<HTMLCanvasElement>('#viewport');
  // Worst case is every magnet grabbing every body, so scale by actor count
  // rather than entity count.
  const renderer = new Renderer(canvas, 128);
  renderer.syncEntities(world);

  const input = new InputSource(canvas);
  const gamepad = new GamepadSource();
  const hud = new Hud(requireEl('#hud'));
  mountTuner(requireEl('#tuner'));

  window.addEventListener('resize', () => renderer.resize());
  requireEl('#loading').remove();

  const snapshots = new SnapshotBuffer();
  const predictor = new Predictor();
  const objects = new ObjectPredictor();
  let viewId: EntityId = online ? 0 : world.playerId;
  let connection: Connection | null = null;

  if (online) {
    connection = new Connection(url, {
      onWelcome: (message) => {
        for (const id of message.players) {
          if (!world.players.has(id)) world.addPlayer(id);
        }
        viewId = message.you;
        // Align the local tick counter with the server's, or reconciliation
        // has no shared clock to compare predictions against.
        world.tick = message.tick;
        predictor.reset();
        objects.reset();
        renderer.syncEntities(world);
      },
      onJoin: (id) => {
        if (!world.players.has(id)) world.addPlayer(id);
        renderer.syncEntities(world);
      },
      onLeave: (id) => world.removePlayer(id),
      onSnapshot: (message) => {
        snapshots.push(message);
        // Compare the server's word for its tick against what we predicted at
        // that same tick — never against the raw position, which is ~100ms old
        // and would drag the player backwards.
        const local = world.players.get(viewId);
        const authoritative = readPlayerPos(message, viewId);
        // Only while alive: a dead player is not predicted at all, so there is
        // nothing to reconcile and the snapshot stamps it directly.
        if (authoritative && local?.alive) {
          predictor.reconcile(message.tick, authoritative, local.entity.pos);
        }
      },
    });
  }

  const lastAim = { x: 0, z: 1 };
  let accumulator = 0;
  let previous = performance.now();
  let pendingDash = false;
  let pendingReset = false;
  let wasPredicting = false;
  const tickInputs = new Map<EntityId, Input>();
  const bots = new BotDirector();

  /**
   * Fixed timestep. The sim only ever advances in whole TICK_DT steps and only
   * ever sees an Input — wall-clock time lives out here and never leaks in.
   * Rendering interpolates across the leftover fraction of a tick.
   */
  function frame(now: number): void {
    requestAnimationFrame(frame);

    let dt = (now - previous) / 1000;
    previous = now;
    // A backgrounded tab produces a huge dt; clamp it or we spiral trying to
    // catch up on minutes of simulation.
    if (dt > 0.25) dt = 0.25;
    accumulator += dt;

    // Gamepads are polled, not evented, so this has to happen every frame.
    gamepad.poll();

    // Consume both sources every frame, and never with `||` — short-circuiting
    // would leave the second source's edge queued until the next frame.
    // `pendingDash` outlives the frame because rendering and simulation run at
    // independent rates: a frame that happens to advance zero ticks must not
    // swallow the press.
    if (input.consumeDash()) pendingDash = true;
    if (gamepad.consumeDash()) pendingDash = true;
    if (input.consumeReset()) pendingReset = true;
    if (gamepad.consumeReset()) pendingReset = true;

    const view = world.players.get(viewId);
    const eye = view?.entity.pos ?? { x: 0, y: 0.55, z: 0 };
    const aimPoint = input.raw.hasPointer
      ? renderer.screenToGround(input.raw.ndcX, input.raw.ndcY, eye.y)
      : null;

    if (online && connection) {
      // Reset is the server's call, not ours; ignore it rather than pretend.
      pendingReset = false;

      const command = buildInput(
        world.tick + 1,
        input.raw,
        gamepad.state.connected ? gamepad.state : null,
        pendingDash,
        eye,
        aimPoint,
        lastAim,
      );
      connection.send(command);

      // Simulate locally so input lands the instant it is pressed. Only our own
      // player is trusted from this: every other body gets stamped back to the
      // server's version immediately after.
      const me = world.players.get(viewId);
      // Prediction is only for a player who is actually in the round. While
      // eliminated the client must hand its body back to the server entirely:
      // it is parked below the arena, and a client still steering it just flies
      // around the void with the camera following.
      const predicting = me?.alive === true;
      if (predicting !== wasPredicting) {
        // Crossing this boundary invalidates every recorded sample — the body
        // is about to teleport, either into the void or back onto the disc.
        predictor.reset();
        objects.reset();
        wasPredicting = predicting;
      }

      let steps = 0;
      while (accumulator >= TICK_DT && steps < MAX_CATCHUP_STEPS) {
        tickInputs.clear();
        if (predicting) tickInputs.set(viewId, { ...command, tick: world.tick + 1 });

        // Replay remote magnets from their last reported state. Their movement
        // does not matter — we stamp their positions anyway — but their pull on
        // shared objects very much does: without it, any ball two people are
        // fighting over diverges instantly and gets handed straight back.
        if (objects.enabled) {
          for (const other of world.players.values()) {
            if (other.id === viewId || !other.alive || other.magnetAxis === 0) continue;
            tickInputs.set(other.id, {
              tick: world.tick + 1,
              moveX: 0,
              moveZ: 0,
              aimX: other.aimX,
              aimZ: other.aimZ,
              magnet: other.magnetAxis,
              dash: false,
            });
          }
        }

        world.step(tickInputs);
        objects.update(world, viewId);
        if (predicting && me) {
          predictor.apply(world, viewId);
          predictor.record(world.tick, me.entity.pos);
        }
        accumulator -= TICK_DT;
        steps++;
      }
      if (steps === MAX_CATCHUP_STEPS) accumulator = 0;
      if (steps > 0) pendingDash = false;

      // After stepping, so remote bodies show the smooth interpolated result
      // rather than a discarded local physics guess.
      // Skip the local player only while predicting it. Dead, it gets stamped
      // like any other body, which is the thing that puts you back on the disc.
      snapshots.apply(world, dt, connection.tickRate, predicting ? viewId : 0, objects);
      renderer.syncEntities(world);
      hud.update(world, viewId, gamepad.state, dt, {
        error: predictor.error,
        snaps: predictor.snaps,
        recoveries: predictor.recoveries,
        lagTicks: snapshots.delayTicks,
        owned: objects.owned,
        fading: objects.fading,
        abandons: objects.abandons,
      });
      renderer.render(world, viewId, 1, dt);
      return;
    }

    if (pendingReset) {
      world = new SimWorld();
      viewId = world.playerId;
      renderer.syncEntities(world);
      accumulator = 0;
      pendingReset = false;
    }

    let steps = 0;
    while (accumulator >= TICK_DT && steps < MAX_CATCHUP_STEPS) {
      const point = input.raw.hasPointer
        ? renderer.screenToGround(input.raw.ndcX, input.raw.ndcY, world.player.pos.y)
        : null;

      tickInputs.clear();
      tickInputs.set(
        world.playerId,
        buildInput(
          world.tick + 1,
          input.raw,
          gamepad.state.connected ? gamepad.state : null,
          pendingDash,
          world.player.pos,
          point,
          lastAim,
        ),
      );
      bots.drive(world, tickInputs);
      world.step(tickInputs);
      // One press must not dash on every catch-up tick of the same frame.
      pendingDash = false;

      accumulator -= TICK_DT;
      steps++;
    }
    if (steps === MAX_CATCHUP_STEPS) accumulator = 0;

    hud.update(world, viewId, gamepad.state, dt);
    renderer.render(world, viewId, accumulator / TICK_DT, dt);
  }

  requestAnimationFrame(frame);
}

void main();
