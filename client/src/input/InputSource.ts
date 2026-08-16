import { MagnetLatch } from './MagnetLatch';

/**
 * Raw device state. Deliberately dumb: it knows about keys and pixels, not
 * about the camera or the world. `buildInput` turns this into the sim's Input.
 */
export interface RawInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  attract: boolean;
  repel: boolean;
  /** Mouse position in normalized device coords, [-1, 1]. */
  ndcX: number;
  ndcY: number;
  hasPointer: boolean;
}

export class InputSource {
  readonly raw: RawInput = {
    forward: false,
    back: false,
    left: false,
    right: false,
    attract: false,
    repel: false,
    ndcX: 0,
    ndcY: 0,
    hasPointer: false,
  };

  private dashQueued = false;
  private resetQueued = false;
  private readonly detach: (() => void)[] = [];

  // Mouse buttons are momentary; Q/E latch. Tracked separately so releasing a
  // mouse button cannot clear a latch, and vice versa.
  private mouseAttract = false;
  private mouseRepel = false;
  private readonly latch = new MagnetLatch();

  constructor(private readonly target: HTMLElement) {
    this.on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    // Aim listens on `window`, buttons listen on the canvas. That asymmetry is
    // deliberate: the cursor must keep steering the magnet even when it is over
    // the tuner panel or off the canvas entirely (very easy to hit with Q/E,
    // since engaging the magnet no longer requires clicking the arena), but a
    // click on a tuner slider must not also fire the magnet.
    this.on(window, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.on(target, 'pointerdown', (e) => this.onPointerButton(e as PointerEvent, true));
    this.on(window, 'pointerup', (e) => this.onPointerButton(e as PointerEvent, false));
    this.on(target, 'contextmenu', (e) => e.preventDefault());
    // Held buttons would otherwise stick on when the tab loses focus.
    this.on(window, 'blur', () => this.releaseAll());
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

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
  }

  private on(el: EventTarget, type: string, fn: (e: Event) => void): void {
    el.addEventListener(type, fn);
    this.detach.push(() => el.removeEventListener(type, fn));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.raw.forward = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.raw.back = down;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.raw.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.raw.right = down;
        break;
      // Toggles, not holds — see MagnetLatch for why. Guard on `repeat` or
      // auto-repeat flickers the latch on and off many times a second.
      case 'KeyQ':
        if (down && !e.repeat) {
          this.latch.toggleAttract();
          this.syncMagnet();
        }
        break;
      case 'KeyE':
        if (down && !e.repeat) {
          this.latch.toggleRepel();
          this.syncMagnet();
        }
        break;
      case 'Escape':
        if (down) {
          this.latch.clear();
          this.syncMagnet();
        }
        break;
      case 'Space':
        e.preventDefault();
        if (down && !e.repeat) this.dashQueued = true;
        break;
      case 'KeyR':
        if (down && !e.repeat) {
          this.resetQueued = true;
          this.latch.clear();
          this.syncMagnet();
        }
        break;
      default:
        return;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    this.trackPointer(e);
  }

  private onPointerButton(e: PointerEvent, down: boolean): void {
    // A click that lands without any prior movement still tells us where the
    // cursor is, so the first shot of a session aims where you clicked.
    this.trackPointer(e);
    if (e.button === 0) this.mouseRepel = down;
    if (e.button === 2) this.mouseAttract = down;
    this.syncMagnet();
  }

  /**
   * Always measured against the canvas rect, even when the pointer is outside
   * it — the resulting out-of-range NDC still ray-casts to a sensible aim.
   */
  private trackPointer(e: PointerEvent): void {
    const rect = this.target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.raw.ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.raw.ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.raw.hasPointer = true;
  }

  /** Either source can hold the magnet on; neither can turn the other off. */
  private syncMagnet(): void {
    this.raw.attract = this.mouseAttract || this.latch.isAttracting;
    this.raw.repel = this.mouseRepel || this.latch.isRepelling;
  }

  private releaseAll(): void {
    this.raw.forward = false;
    this.raw.back = false;
    this.raw.left = false;
    this.raw.right = false;
    this.mouseAttract = false;
    this.mouseRepel = false;
    // A latch left on across a tab switch would have the magnet mysteriously
    // running the moment you come back.
    this.latch.clear();
    this.syncMagnet();
  }
}
