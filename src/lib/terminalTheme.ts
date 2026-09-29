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

/** The terminal is the canvas: same background, same text colour, ANSI tuned to it. */
export function palette() {
  const dark = DARK_SCHEME.matches;
  const background = cssColor("var(--color-canvas)", dark ? "#1a1a1a" : "#ffffff");
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
