import { createContext, createElement, useCallback, useContext, useEffect, useState } from "react";
import * as api from "../lib/api";
import { DEFAULT_BROWSER_PREFS, parseBrowserPrefs, type BrowserPrefs } from "../lib/browserPrefs";

const KEY = "browser:prefs";

type Value = { prefs: BrowserPrefs; update: (next: BrowserPrefs) => void };

const Context = createContext<Value>({ prefs: DEFAULT_BROWSER_PREFS, update: () => {} });

/** One store for every page and the settings page; a change applies to open tabs. */
export function BrowserPrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState(DEFAULT_BROWSER_PREFS);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => !cancelled && setPrefs(parseBrowserPrefs(raw)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: BrowserPrefs) => {
    setPrefs(next);
    void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  return createElement(Context.Provider, { value: { prefs, update } }, children);
}

export const useBrowserPrefs = () => useContext(Context);
