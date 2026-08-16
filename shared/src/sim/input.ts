/**
 * One tick's worth of player intent.
 *
 * This is deliberately small, flat and serializable: when the server arrives
 * in Phase 4 this struct *is* the packet the client sends, and the sim already
 * consumes nothing else. Never read the keyboard, mouse or gamepad inside the
 * sim.
 */
export interface Input {
  /** Sim tick this input applies to. */
  tick: number;
  /**
   * Desired movement on the XZ plane. The *magnitude* is a throttle, so an
   * analog stick can walk slowly; keyboard input is always full deflection.
   * Clamped to 1 by the sim, so a diagonal is not faster than a cardinal.
   */
  moveX: number;
  moveZ: number;
  /** Aim direction on the XZ plane, normalized. Axis of the magnet cone. */
  aimX: number;
  aimZ: number;
  /**
   * Signed magnet throttle in [-1, 1]: negative attracts, positive repels,
   * 0 is off. Buttons and keys produce exactly ±1; analog triggers produce
   * everything in between, which is the main thing a gamepad buys you here.
   */
  magnet: number;
  dash: boolean;
}

export function emptyInput(tick = 0): Input {
  return { tick, moveX: 0, moveZ: 0, aimX: 0, aimZ: 1, magnet: 0, dash: false };
}
