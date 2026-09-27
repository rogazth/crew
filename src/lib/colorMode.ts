/** Light or dark for the whole app, pages included. System follows macOS. */
export const COLOR_MODES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

export type ColorMode = (typeof COLOR_MODES)[number]["id"];

export const DEFAULT_COLOR_MODE: ColorMode = "system";

export function parseColorMode(raw: string | null | undefined): ColorMode {
  return COLOR_MODES.some((mode) => mode.id === raw) ? (raw as ColorMode) : DEFAULT_COLOR_MODE;
}
