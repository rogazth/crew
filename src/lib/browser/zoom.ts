/** The steps ⌘+ and ⌘- walk through, as zoom factors. */
export const ZOOM_STEPS = [0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/**
 * The next step from `factor` in `direction`; 0 resets. A factor between steps
 * (another origin's zoom, restored by Chromium) moves to the nearest step that
 * way rather than skipping one.
 */
export function stepZoom(factor: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return 1;
  const EPSILON = 0.001;
  if (direction > 0) return ZOOM_STEPS.find((step) => step > factor + EPSILON) ?? ZOOM_STEPS.at(-1)!;
  return [...ZOOM_STEPS].reverse().find((step) => step < factor - EPSILON) ?? ZOOM_STEPS[0];
}

/** "110%". Only shown when the page isn't at its actual size. */
export function zoomLabel(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}
