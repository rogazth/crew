export type Ligatures = "auto" | "on" | "off";

export type TerminalPrefs = {
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  fontWeightBold: number;
  lineHeight: number;
  ligatures: Ligatures;
};

/** "SF Mono" is not installed as a font; WebKit reaches it through `ui-monospace`. */
export const SYSTEM_MONO = "SF Mono";

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 14,
  fontFamily: SYSTEM_MONO,
  fontWeight: 500,
  fontWeightBold: 700,
  lineHeight: 1,
  ligatures: "auto",
};

export const LIMITS = {
  fontSize: { min: 8, max: 32 },
  fontWeight: { min: 100, max: 900 },
  lineHeight: { min: 1, max: 3 },
} as const;

/** Fonts that ship no programming ligatures, so "auto" leaves the addon off. */
const NO_LIGATURES = new Set([
  SYSTEM_MONO,
  "Menlo",
  "Monaco",
  "Courier New",
  "Andale Mono",
  "DejaVu Sans Mono",
  "PT Mono",
  "Ubuntu Mono",
  "Roboto Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Hack",
  "Inconsolata",
  "Consolas",
]);

export function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, value));
}

export function fontStack(family: string): string {
  const system = "ui-monospace, Menlo, Monaco, monospace";
  return family === SYSTEM_MONO ? system : `"${family}", ${system}`;
}

export function ligaturesEnabled(prefs: TerminalPrefs): boolean {
  if (prefs.ligatures !== "auto") return prefs.ligatures === "on";
  return !NO_LIGATURES.has(prefs.fontFamily);
}

export function parseTerminalPrefs(raw: string | null): TerminalPrefs {
  if (!raw) return DEFAULT_TERMINAL_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<TerminalPrefs>;
    return {
      fontSize: number(parsed.fontSize, LIMITS.fontSize, DEFAULT_TERMINAL_PREFS.fontSize),
      fontFamily:
        typeof parsed.fontFamily === "string" && parsed.fontFamily.trim()
          ? parsed.fontFamily
          : DEFAULT_TERMINAL_PREFS.fontFamily,
      fontWeight: number(parsed.fontWeight, LIMITS.fontWeight, DEFAULT_TERMINAL_PREFS.fontWeight),
      fontWeightBold: number(
        parsed.fontWeightBold,
        LIMITS.fontWeight,
        DEFAULT_TERMINAL_PREFS.fontWeightBold,
      ),
      lineHeight: number(parsed.lineHeight, LIMITS.lineHeight, DEFAULT_TERMINAL_PREFS.lineHeight),
      ligatures:
        parsed.ligatures === "on" || parsed.ligatures === "off" ? parsed.ligatures : "auto",
    };
  } catch {
    return DEFAULT_TERMINAL_PREFS;
  }
}

function number(value: unknown, limits: { min: number; max: number }, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, limits) : fallback;
}
