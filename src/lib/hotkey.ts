/** Platform facts the chrome needs. Key matching and formatting live in @tanstack/react-hotkeys. */

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** ⌘⌫ on macOS, Delete elsewhere: the platform's "remove the focused row" chord. */
export function isDeleteChord(event: { key: string; metaKey: boolean }): boolean {
  return IS_MAC ? event.key === "Backspace" && event.metaKey : event.key === "Delete";
}

/**
 * ⌥ and a letter alone, the prompt's picker keys (⌥P, ⌥W). By the key under it,
 * since on macOS ⌥P types π. The open picker answers the same key by closing.
 */
export function isAltLetter(event: { code: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, letter: string): boolean {
  return event.code === `Key${letter}` && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
}
