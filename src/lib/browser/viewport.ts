/** A fixed page size for checking a layout at another width, instead of the pane's. */
export type Viewport = { width: number; height: number };

export const VIEWPORT_PRESETS = [
  { id: "phone", label: "Phone", width: 390, height: 844 },
  { id: "tablet", label: "Tablet", width: 820, height: 1180 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
] as const;

export type PresetId = (typeof VIEWPORT_PRESETS)[number]["id"];

export const VIEWPORT_LIMITS = { min: 200, max: 4000 } as const;

export function preset(id: PresetId): Viewport {
  const found = VIEWPORT_PRESETS.find((item) => item.id === id) ?? VIEWPORT_PRESETS[0];
  return { width: found.width, height: found.height };
}

/** Whole pixels inside the limits; anything that isn't a number keeps the old side. */
export function clampSide(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(VIEWPORT_LIMITS.max, Math.max(VIEWPORT_LIMITS.min, Math.round(value)));
}

export function rotate(viewport: Viewport): Viewport {
  return { width: viewport.height, height: viewport.width };
}

/** The preset a size came from, in either orientation, so its chip stays lit after a rotate. */
export function presetOf(viewport: Viewport): PresetId | null {
  const match = VIEWPORT_PRESETS.find(
    (item) =>
      (item.width === viewport.width && item.height === viewport.height) ||
      (item.width === viewport.height && item.height === viewport.width),
  );
  return match?.id ?? null;
}
