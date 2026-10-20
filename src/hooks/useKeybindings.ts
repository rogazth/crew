import { useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { keyOverrides, onKeyOverridesChange, setKeyOverrides, type KeyOverrides } from "../lib/commands";
import { readStored } from "../lib/keybindings";
import { IS_MAC } from "../lib/hotkey";

const KEY = "keybindings:overrides";

/** Binds the saved overrides once the window is up; a command is on its default until they arrive. */
export function useLoadKeybindings() {
  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => !cancelled && setKeyOverrides(readStored(raw, IS_MAC)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
}

/** Applies `next` everywhere at once (the window's keys, the keys main forwards from pages) and saves it. */
export function saveKeyOverrides(next: KeyOverrides): void {
  setKeyOverrides(next);
  void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
}

export function useKeyOverrides(): KeyOverrides {
  return useSyncExternalStore(onKeyOverridesChange, keyOverrides);
}
