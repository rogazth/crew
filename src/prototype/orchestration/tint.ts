// PROTOTYPE — one colour per participant, the way a worktree gets one: a hue from its name.
import type { CSSProperties } from "react";

/** A stable hue for a name, so a sender reads the same everywhere. */
export function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** A name in its colour: dark enough on light, light enough on dark, the BranchTag chroma. */
export function tint(name: string): CSSProperties {
  const hue = hueOf(name);
  return { color: `light-dark(oklch(50% 0.14 ${hue}), oklch(78% 0.11 ${hue}))` };
}
