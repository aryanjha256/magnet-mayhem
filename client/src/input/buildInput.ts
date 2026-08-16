import type { Input } from '@magnet/shared/sim/input';
import type { Vec3 } from '@magnet/shared/sim/types';
import type { GamepadState } from './GamepadSource';
import type { RawInput } from './InputSource';

/**
 * Device state + where the cursor lands in the world -> one tick of sim Input.
 *
 * Lives here rather than in InputSource because it needs the camera's answer
 * to "what is the cursor pointing at", and InputSource must not know about a
 * camera. main.ts wires them together.
 *
 * Gamepad wins per-channel, not wholesale: you can steer with the stick while
 * still aiming with the mouse, or vice versa, and an idle pad never suppresses
 * the keyboard.
 */
export function buildInput(
  tick: number,
  raw: RawInput,
  pad: GamepadState | null,
  dash: boolean,
  playerPos: Vec3,
  aimPoint: Vec3 | null,
  lastAim: { x: number; z: number },
): Input {
  let moveX = (raw.right ? 1 : 0) - (raw.left ? 1 : 0);
  // The camera looks down -Z, so W is -Z.
  let moveZ = (raw.back ? 1 : 0) - (raw.forward ? 1 : 0);
  if (pad && (pad.moveX !== 0 || pad.moveZ !== 0)) {
    moveX = pad.moveX;
    moveZ = pad.moveZ;
  }

  let aimX = lastAim.x;
  let aimZ = lastAim.z;
  if (pad?.hasAim) {
    aimX = pad.aimX;
    aimZ = pad.aimZ;
  } else if (aimPoint) {
    const dx = aimPoint.x - playerPos.x;
    const dz = aimPoint.z - playerPos.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-3) {
      aimX = dx / len;
      aimZ = dz / len;
    }
  }
  lastAim.x = aimX;
  lastAim.z = aimZ;

  return {
    tick,
    moveX,
    moveZ,
    aimX,
    aimZ,
    magnet: resolveMagnet(raw, pad),
    dash,
  };
}

/**
 * Triggers beat keys and mouse buttons, because a trigger can express
 * "slightly on" and the others cannot — falling back mid-squeeze would snap
 * the force to full.
 *
 * Opposing inputs cancel to zero either way, which makes "let go of everything"
 * a single reliable panic move rather than a race between two controls.
 */
function resolveMagnet(raw: RawInput, pad: GamepadState | null): number {
  if (pad && (pad.attract > 0 || pad.repel > 0)) {
    if (pad.attract > 0 && pad.repel > 0) return 0;
    return pad.attract > 0 ? -pad.attract : pad.repel;
  }
  if (raw.attract && !raw.repel) return -1;
  if (raw.repel && !raw.attract) return 1;
  return 0;
}
