import { ANSI_DARK, ANSI_LIGHT, rgbToHex } from "./terminalColors";

export const DARK_SCHEME = window.matchMedia("(prefers-color-scheme: dark)");

function cssColor(expr: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = expr;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return rgbToHex(color || fallback);
}

/** What a probe computes `expr` to, as the browser would paint it. */
function computed(expr: string): string {
  const probe = document.createElement("span");
  probe.style.color = expr;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/**
 * Translucent `layers` painted over one another, as one opaque colour: a fill
 * like the card's is a tint of what is under it, and xterm wants it solid.
 */
function composite(layers: string[], fallback: string): string {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;
  for (const layer of layers) {
    context.fillStyle = computed(layer);
    context.fillRect(0, 0, 1, 1);
  }
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The terminal is the canvas: same background, same text colour, ANSI tuned to
 * it. `ground` lays another surface over the canvas, for a terminal set in a
 * filled block (the card's tint).
 */
export function palette(ground?: string) {
  const dark = DARK_SCHEME.matches;
  const canvas = dark ? "#1a1a1a" : "#ffffff";
  const background = ground ? composite(["var(--color-canvas)", ground], canvas) : cssColor("var(--color-canvas)", canvas);
  const foreground = cssColor("var(--color-text)", dark ? "#e8eef2" : "#2e2e2e");
  return {
    background,
    foreground,
    cursor: cssColor("var(--color-accent)", foreground),
    cursorAccent: background,
    selectionBackground: dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)",
    selectionInactiveBackground: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.07)",
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}
