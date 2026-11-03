import { defineSetting } from "./settingsEngine/define";

/** The daemon reads the same key: "on" runs every session without asking, absent leaves each to its own. */
export const BYPASS_KEY = "sessions:bypass-permissions";

export const bypassPermissions = defineSetting<boolean>({
  key: BYPASS_KEY,
  scope: "global",
  fallback: false,
  parse: (raw) => raw?.trim() === "on",
  format: (value) => (value ? "on" : null),
});
