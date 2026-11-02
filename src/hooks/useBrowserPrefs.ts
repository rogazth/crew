import { browserPrefsSetting, type BrowserPrefs } from "../lib/browserPrefs";
import { saveSetting, useSetting } from "../lib/settingsEngine/store";

const update = (next: BrowserPrefs) => saveSetting(browserPrefsSetting, next);

/** One store for every page and the settings page; a change applies to open tabs. */
export function useBrowserPrefs() {
  return { prefs: useSetting(browserPrefsSetting), update };
}
