/** Platform facts the chrome needs. Key matching and formatting live in @tanstack/react-hotkeys. */

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** ⌘⌫ on macOS, Delete elsewhere: the platform's "remove the focused row" chord. */
export function isDeleteChord(event: { key: string; metaKey: boolean }): boolean {
  return IS_MAC ? event.key === "Backspace" && event.metaKey : event.key === "Delete";
}
