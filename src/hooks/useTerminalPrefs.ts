import { saveSetting, useSetting } from "../lib/settingsEngine/store";
import { terminalPrefsSetting, type TerminalPrefs } from "../lib/terminalPrefs";

const update = (next: TerminalPrefs) => saveSetting(terminalPrefsSetting, next);

/** One store for every terminal and the settings page; edits apply to running terminals. */
export function useTerminalPrefs() {
  return { prefs: useSetting(terminalPrefsSetting), update };
}
