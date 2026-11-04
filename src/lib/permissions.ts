import type { Access } from "./providers";
import { defineSetting } from "./settingsEngine/define";

/** The daemon reads the same key: setting it gives every session and bot this access. */
export const ACCESS_KEY = "sessions:access";

const LEVELS: readonly string[] = ["ask", "edits", "auto", "full"];

/** Null until it is chosen, and new sessions start from the preferred agent's own. */
export const sessionAccess = defineSetting<Access | null>({
  key: ACCESS_KEY,
  scope: "global",
  fallback: null,
  parse: (raw) => {
    const value = raw?.trim();
    return value && LEVELS.includes(value) ? (value as Access) : null;
  },
  format: (value) => value,
});
