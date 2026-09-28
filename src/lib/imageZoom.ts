/** How an image file tab scales its picture. */

/** The scales ⌘= and ⌘- step through. */
const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
/** Room left around a fitted image, in CSS pixels. */
export const GUTTER = 32;

export type Size = { width: number; height: number };

/** Fits the image in the pane, never enlarging it: a small icon shows at its own size until zoomed. */
export function fitScale(image: Size, pane: Size): number {
  if (image.width === 0 || image.height === 0) return 1;
  const room = { width: Math.max(pane.width - GUTTER * 2, 1), height: Math.max(pane.height - GUTTER * 2, 1) };
  return Math.min(1, room.width / image.width, room.height / image.height);
}

/** The next step past `scale`, up or down; stays put at either end. */
export function stepScale(scale: number, direction: 1 | -1): number {
  if (direction > 0) return STEPS.find((step) => step > scale + 1e-6) ?? scale;
  return [...STEPS].reverse().find((step) => step < scale - 1e-6) ?? scale;
}

export const MIN_SCALE = STEPS[0]!;
export const MAX_SCALE = STEPS[STEPS.length - 1]!;
