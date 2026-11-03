import { useEffect, useSyncExternalStore } from "react";
import { keyOverrides, onKeyOverridesChange, setKeyOverrides, type KeyOverrides } from "../lib/commands";
import { keybindingsSetting } from "../lib/keybindings";
import { readSetting, saveSetting } from "../lib/settingsEngine/store";

/** Binds the saved overrides once the window is up; a command is on its default until they arrive. */
export function useLoadKeybindings() {
  useEffect(() => {
    let cancelled = false;
    readSetting(keybindingsSetting)
      .then((overrides) => !cancelled && setKeyOverrides(overrides))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
}

/** Applies `next` everywhere at once (the window's keys, the keys main forwards from pages) and saves it. */
export function saveKeyOverrides(next: KeyOverrides): void {
  setKeyOverrides(next);
  saveSetting(keybindingsSetting, next);
}

export function useKeyOverrides(): KeyOverrides {
  return useSyncExternalStore(onKeyOverridesChange, keyOverrides);
}
