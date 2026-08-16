/**
 * Latching polarity for keyboard magnet control.
 *
 * Mouse buttons are momentary — you hold them. Keys cannot be, on a laptop:
 * libinput's disable-while-typing switches the touchpad off while a letter key
 * is held (auto-repeat keeps it off), so "hold Q and aim" is physically
 * impossible. Q/E therefore toggle instead of hold, which frees the hand that
 * moves the cursor.
 *
 * The one rule worth stating: turning one polarity on turns the other off, so
 * the attract -> flip -> repel combo is a single keypress rather than a release
 * and a press.
 */
export class MagnetLatch {
  private attract = false;
  private repel = false;

  get isAttracting(): boolean {
    return this.attract;
  }

  get isRepelling(): boolean {
    return this.repel;
  }

  toggleAttract(): void {
    const next = !this.attract;
    this.attract = next;
    if (next) this.repel = false;
  }

  toggleRepel(): void {
    const next = !this.repel;
    this.repel = next;
    if (next) this.attract = false;
  }

  clear(): void {
    this.attract = false;
    this.repel = false;
  }
}
