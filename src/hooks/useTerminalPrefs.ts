import { createContext, createElement, useCallback, useContext, useEffect, useState } from "react";
import * as api from "../lib/api";
import {
  DEFAULT_TERMINAL_PREFS,
  parseTerminalPrefs,
  type TerminalPrefs,
} from "../lib/terminalPrefs";

const KEY = "terminal:prefs";

type Value = { prefs: TerminalPrefs; update: (next: TerminalPrefs) => void };

const Context = createContext<Value>({ prefs: DEFAULT_TERMINAL_PREFS, update: () => {} });

/** One store for every terminal and the settings page; edits apply to running terminals. */
export function TerminalPrefsProvider({ children }: { children: React.ReactNode }) {
  const [saved, setSaved] = useState(DEFAULT_TERMINAL_PREFS);
  // An edit made before the saved prefs arrive wins over them.
  const [edited, setEdited] = useState<TerminalPrefs | null>(null);
  const prefs = edited ?? saved;

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => !cancelled && setSaved(parseTerminalPrefs(raw)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: TerminalPrefs) => {
    setEdited(next);
    void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  return createElement(Context.Provider, { value: { prefs, update } }, children);
}

export const useTerminalPrefs = () => useContext(Context);
