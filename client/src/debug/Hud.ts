import type { GamepadState } from '../input/GamepadSource';
import { TICK_RATE } from '@magnet/shared/sim/World';
import { TUNABLES } from '@magnet/shared/sim/tunables';
import type { SimWorld } from '@magnet/shared/sim/World';
import type { EntityId } from '@magnet/shared/sim/types';

/** Numbers worth watching while tuning: speed, tick, deaths, frame cost. */
export class Hud {
  private frames = 0;
  private elapsed = 0;
  private fps = 0;

  constructor(private readonly el: HTMLElement) {}

  update(world: SimWorld, viewId: EntityId, pad: GamepadState, dt: number): void {
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed >= 0.25) {
      this.fps = this.frames / this.elapsed;
      this.frames = 0;
      this.elapsed = 0;
    }

    const view = world.players.get(viewId);
    const v = view?.velocity ?? { x: 0, y: 0, z: 0 };
    const speed = Math.hypot(v.x, v.y, v.z);
    const dashSeconds = (view?.dashCooldown ?? 0) / TICK_RATE;

    // Q/E latch and triggers are analog, so the magnet can be part-on with
    // nothing held. Without a readout that state is invisible.
    const axis = view?.magnetAxis ?? 0;
    const magnet =
      axis === 0
        ? 'off'
        : `${axis < 0 ? 'ATTRACT' : 'REPEL'} ${(Math.abs(axis) * 100).toFixed(0)}%`;

    const m = world.match;
    const alive = world.alivePlayers.length;
    const seconds = (m.timer / TICK_RATE).toFixed(1);
    const status =
      m.phase === 'countdown'
        ? `round ${m.round} in ${seconds}s`
        : m.phase === 'playing'
          ? `round ${m.round}  ${alive} left  ${seconds}s`
          : m.phase === 'roundOver'
            ? m.lastWinner === viewId ? 'ROUND WON' : `round to #${m.lastWinner}`
            : m.champion === viewId ? 'MATCH WON' : `match to #${m.champion}`;

    const lines = [
      status,
      `wins   ${view?.roundWins ?? 0} / ${TUNABLES.roundsToWin}`,
      `arena  ${m.arenaRadius.toFixed(1)}m`,
      view?.alive === false ? 'ELIMINATED' : '',
      `fps    ${this.fps.toFixed(0)}`,
      `tick   ${world.tick}`,
      `speed  ${speed.toFixed(1)} m/s`,
      `dash   ${dashSeconds > 0 ? `${dashSeconds.toFixed(1)}s` : 'ready'}`,
      `falls  ${view?.deaths ?? 0}`,
      `kos    ${view?.knockouts ?? 0}`,
      `players ${world.players.size}`,
      `magnet ${magnet}`,
    ];

    if (pad.connected) {
      // Live pad readout: two different controllers can map differently, and
      // this is the fastest way to see which axes and triggers are actually
      // arriving.
      lines.push(
        '',
        `pad    ${truncate(pad.id, 28)}`,
        `  move ${fmt(pad.moveX)},${fmt(pad.moveZ)}`,
        `  aim  ${pad.hasAim ? `${fmt(pad.aimX)},${fmt(pad.aimZ)}` : '—'}`,
        `  LT/RT ${fmt(pad.attract)} ${fmt(pad.repel)}`,
      );
    }

    this.el.textContent = lines.filter((l) => l !== '').join('\n');
  }
}

function fmt(v: number): string {
  return (v < 0 ? '' : '+') + v.toFixed(2);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
