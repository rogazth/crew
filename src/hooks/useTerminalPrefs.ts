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
  const [prefs, setPrefs] = useState(DEFAULT_TERMINAL_PREFS);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => !cancelled && setPrefs(parseTerminalPrefs(raw)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: TerminalPrefs) => {
    setPrefs(next);
    void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  return createElement(Context.Provider, { value: { prefs, update } }, children);
}

export const useTerminalPrefs = () => useContext(Context);
