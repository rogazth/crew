/**
 * The app's palette. One shape for every accent (radii, shadows, layout);
 * only the colour tokens change, keyed on `<html data-accent>` in index.css.
 */
export const ACCENTS = [
  { id: "ink", label: "Ink" },
  { id: "teal", label: "Teal" },
  { id: "cobalt", label: "Cobalt" },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];

export const DEFAULT_ACCENT: AccentId = "ink";

export function parseAccent(raw: string | null | undefined): AccentId {
  return ACCENTS.some((accent) => accent.id === raw) ? (raw as AccentId) : DEFAULT_ACCENT;
}

/** The redesign's dev switch called the palettes a, b and c; null for anything else (including "off"). */
export function accentFromDirection(raw: string | null | undefined): AccentId | null {
  switch (raw) {
    case "a":
      return "ink";
    case "b":
      return "teal";
    case "c":
      return "cobalt";
    default:
      return null;
  }
}
