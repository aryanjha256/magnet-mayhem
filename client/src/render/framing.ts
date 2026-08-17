import { PLATFORM_RADIUS } from '@magnet/shared/sim/arena';

/**
 * How far back the camera has to sit to fit a disc of `arenaRadius` on screen.
 *
 * Kept free of Three.js so it can be checked headlessly — a fit calculation
 * that is subtly wrong just crops the arena, which is easy to miss by eye and
 * exactly the sort of thing that only shows up on someone else's monitor.
 */
export function cameraDistanceFor(
  arenaRadius: number,
  verticalFovDeg: number,
  aspect: number,
  margin: number,
  padding = 1.5,
): number {
  const framed = arenaRadius * margin + padding;
  const halfV = (verticalFovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 0.01));

  // Whichever axis is tighter wins. On a wide window that is the vertical FOV;
  // on a tall or narrow one it becomes the horizontal.
  return Math.max(framed / Math.tan(halfV), framed / Math.tan(halfH));
}

/**
 * The camera distance for play. Frames the arena at its **starting** size and
 * never changes with the shrink — note that it takes no radius at all, which is
 * the point.
 *
 * Tracking the live radius seemed obviously right and was clearly wrong in
 * play: players and objects grew on screen as the round went on, which reads as
 * the camera zooming rather than the floor closing in, and it destroys the
 * constant screen-to-world mapping that makes mouse aiming feel stable. Holding
 * the frame still lets the shrink show as what it actually is — the void eating
 * the arena from the edges.
 */
export function arenaCameraDistance(
  verticalFovDeg: number,
  aspect: number,
  margin: number,
): number {
  return cameraDistanceFor(PLATFORM_RADIUS, verticalFovDeg, aspect, margin);
}
