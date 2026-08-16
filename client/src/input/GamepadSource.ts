/**
 * Gamepad polling. Like InputSource, this is dumb device state — it knows about
 * sticks and triggers, not about the camera or the world.
 *
 * Twin-stick is arguably this game's native scheme rather than a fallback: left
 * stick moves, right stick aims, and the analog triggers give variable magnet
 * strength, which a key or a mouse button cannot.
 *
 * Note that browsers hide gamepads until the page has seen one button press —
 * a freshly connected pad reports nothing until you touch it.
 */

/** Standard Gamepad layout. Xbox and DualShock/DualSense both report this. */
const BTN_DASH = 0; // A / Cross
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_LT = 6;
const BTN_RT = 7;
const BTN_SELECT = 8; // Back / Share
const BTN_START = 9; // Start / Options

const STICK_DEADZONE = 0.18;
const TRIGGER_DEADZONE = 0.06;

export interface GamepadState {
  connected: boolean;
  id: string;
  /** Deadzoned left stick. Magnitude is a throttle, not just a direction. */
  moveX: number;
  moveZ: number;
  /** Normalized right-stick aim. Only meaningful when `hasAim`. */
  aimX: number;
  aimZ: number;
  hasAim: boolean;
  /** 0..1 from the analog triggers, or 1 from the shoulder buttons. */
  attract: number;
  repel: number;
}

export class GamepadSource {
  readonly state: GamepadState = {
    connected: false,
    id: '',
    moveX: 0,
    moveZ: 0,
    aimX: 0,
    aimZ: 1,
    hasAim: false,
    attract: 0,
    repel: 0,
  };

  private dashQueued = false;
  private resetQueued = false;
  private prevDash = false;
  private prevReset = false;

  /** Call once per rendered frame, before building any sim input. */
  poll(): void {
    const pad = firstConnectedPad();
    if (!pad) {
      this.state.connected = false;
      this.state.id = '';
      this.state.moveX = 0;
      this.state.moveZ = 0;
      this.state.hasAim = false;
      this.state.attract = 0;
      this.state.repel = 0;
      this.prevDash = false;
      this.prevReset = false;
      return;
    }

    this.state.connected = true;
    this.state.id = pad.id;

    // Stick Y is negative when pushed up, and the camera looks down -Z, so
    // "up" and "forward" already agree. No inversion needed.
    const move = radialDeadzone(axis(pad, 0), axis(pad, 1), STICK_DEADZONE);
    this.state.moveX = move.x;
    this.state.moveZ = move.y;

    const aim = radialDeadzone(axis(pad, 2), axis(pad, 3), STICK_DEADZONE);
    this.state.hasAim = aim.magnitude > 0;
    if (this.state.hasAim) {
      // Aim is a pure direction; stick magnitude must not scale it, or a
      // half-pushed stick would aim somewhere different from a full one.
      this.state.aimX = aim.x / aim.magnitude;
      this.state.aimZ = aim.y / aim.magnitude;
    }

    // Shoulder buttons double as a digital fallback for pads whose triggers do
    // not report analog values through the standard mapping.
    this.state.attract = Math.max(trigger(pad, BTN_LT), pressed(pad, BTN_LB) ? 1 : 0);
    this.state.repel = Math.max(trigger(pad, BTN_RT), pressed(pad, BTN_RB) ? 1 : 0);

    const dash = pressed(pad, BTN_DASH);
    if (dash && !this.prevDash) this.dashQueued = true;
    this.prevDash = dash;

    const reset = pressed(pad, BTN_START) || pressed(pad, BTN_SELECT);
    if (reset && !this.prevReset) this.resetQueued = true;
    this.prevReset = reset;
  }

  /** True at most once per press. Call exactly once per tick. */
  consumeDash(): boolean {
    const queued = this.dashQueued;
    this.dashQueued = false;
    return queued;
  }

  consumeReset(): boolean {
    const queued = this.resetQueued;
    this.resetQueued = false;
    return queued;
  }
}

function firstConnectedPad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  for (const pad of navigator.getGamepads()) {
    if (pad?.connected) return pad;
  }
  return null;
}

function axis(pad: Gamepad, index: number): number {
  return pad.axes[index] ?? 0;
}

function pressed(pad: Gamepad, index: number): boolean {
  return pad.buttons[index]?.pressed ?? false;
}

function trigger(pad: Gamepad, index: number): number {
  const button = pad.buttons[index];
  if (!button) return 0;
  // `value` is analog on standard-mapped pads; `pressed` covers the rest.
  const value = button.value || (button.pressed ? 1 : 0);
  return value < TRIGGER_DEADZONE ? 0 : (value - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE);
}

/**
 * Radial deadzone, rescaled so the usable range still spans a full 0..1 —
 * without the rescale, the stick jumps to 18% the instant it leaves centre.
 */
function radialDeadzone(
  x: number,
  y: number,
  deadzone: number,
): { x: number; y: number; magnitude: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude < deadzone) return { x: 0, y: 0, magnitude: 0 };
  const scaled = Math.min((magnitude - deadzone) / (1 - deadzone), 1);
  return { x: (x / magnitude) * scaled, y: (y / magnitude) * scaled, magnitude: scaled };
}
