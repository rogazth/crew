/** Reopen where you left off: absent or "on" restores the last workspace, "off" starts at Home. */
export const REOPEN_KEY = "startup:reopen";

export function parseReopen(raw: string | null): boolean {
  return raw?.trim() !== "off";
}
