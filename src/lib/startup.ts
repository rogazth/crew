import { defineSetting } from "./settingsEngine/define";

/** Reopen where you left off: absent or "on" restores the last workspace, "off" starts at Home. */
export const REOPEN_KEY = "startup:reopen";

export function parseReopen(raw: string | null): boolean {
  return raw?.trim() !== "off";
}

export const reopenSetting = defineSetting<boolean>({
  key: REOPEN_KEY,
  scope: "device",
  fallback: true,
  parse: parseReopen,
  format: (value) => (value ? null : "off"),
});
