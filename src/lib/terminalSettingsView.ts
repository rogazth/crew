import { clamp, DEFAULT_TERMINAL_PREFS, LIMITS, ligaturesEnabled, type TerminalPrefs } from "./terminalPrefs";

type Limits = { min: number; max: number };

/** Float steps (0.1) accumulate noise; snapping through toFixed keeps 1.2 as "1.2". */
export function snap(value: number, step: number, limits: Limits): number {
  return clamp(Number((Math.round(value / step) * step).toFixed(3)), limits);
}

/**
 * A typed stepper value on blur or Enter: what the field shows next, and the
 * value to commit when it differs from the current one. Garbage restores.
 */
export function commitStep(
  draft: string,
  value: number,
  step: number,
  limits: Limits,
): { draft: string; commit: number | null } {
  const parsed = Number(draft);
  if (!Number.isFinite(parsed)) return { draft: String(value), commit: null };
  const next = snap(parsed, step, limits);
  return { draft: String(next), commit: next !== value ? next : null };
}

/** One click of − or +. */
export function nudge(value: number, direction: 1 | -1, step: number, limits: Limits): number {
  return snap(value + direction * step, step, limits);
}

/** What "Auto" would do for the chosen font. */
export function ligaturesNote(prefs: TerminalPrefs): string {
  return ligaturesEnabled({ ...prefs, ligatures: "auto" })
    ? `Auto turns them on for "${prefs.fontFamily}".`
    : `Auto leaves them off for "${prefs.fontFamily}".`;
}

/** ⌘+ and ⌘− step the font size within its limits; ⌘0 puts it back. */
export function zoomed(prefs: TerminalPrefs, delta: number): TerminalPrefs {
  return {
    ...prefs,
    fontSize: delta === 0 ? DEFAULT_TERMINAL_PREFS.fontSize : clamp(prefs.fontSize + delta, LIMITS.fontSize),
  };
}
