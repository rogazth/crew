export const ANSI_DARK = {
  black: "#1d2428",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e8eef2",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

export const ANSI_LIGHT = {
  black: "#383a42",
  red: "#e45649",
  green: "#50a14f",
  yellow: "#c18401",
  blue: "#4078f2",
  magenta: "#a626a4",
  cyan: "#0184bc",
  white: "#fafafa",
  brightBlack: "#7c8591",
  brightRed: "#df6b60",
  brightGreen: "#68b567",
  brightYellow: "#d19a2f",
  brightBlue: "#5c89f5",
  brightMagenta: "#b54bb3",
  brightCyan: "#1f9cc9",
  brightWhite: "#ffffff",
};

/** `rgb(r, g, b)` as computed styles report it, to `#rrggbb`. Anything else passes through. */
export function rgbToHex(color: string): string {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!match) return color;
  return `#${match.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

/** OSC 10/11/12 payload from a CLI asking for the fg/bg/cursor colour. */
export const isOscColorQuery = (data: string): boolean => data.startsWith("?");

/** `#rrggbb` in the `rgb:rrrr/gggg/bbbb` form CLIs expect back. */
export function oscColorReply(code: 10 | 11 | 12, hex: string): string {
  const value = hex.replace(/^#/, "");
  if (value.length !== 6) return "";
  const [r, g, b] = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)];
  return `\x1b]${code};rgb:${r}${r}/${g}${g}/${b}${b}\x1b\\`;
}
