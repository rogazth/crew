import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type SearchResults = { index: number; count: number };

const NO_RESULTS: SearchResults = { index: -1, count: 0 };

/** Decorations need solid hex, so the theme cannot come from a CSS variable. */
function decorations(dark: boolean) {
  return {
    matchBackground: dark ? "#5a4a12" : "#ffe9a8",
    matchOverviewRuler: dark ? "#5a4a12" : "#ffe9a8",
    activeMatchBackground: dark ? "#a97c19" : "#ffc44d",
    activeMatchColorOverviewRuler: dark ? "#a97c19" : "#ffc44d",
    activeMatchBorder: dark ? "#f0d089" : "#8a6100",
  };
}

/** ⌘F over the scrollback. `token` reopens the field and re-selects what is in it. */
export function useTerminalSearch(term: RefObject<Terminal | null>, dark: () => boolean) {
  const addon = useRef<SearchAddon | null>(null);
  const [open, setOpen] = useState<{ token: number } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(NO_RESULTS);
  // Read through a ref so a caller passing a new function each render does not
  // re-run the search each render, which reports results, which renders again.
  const darkRef = useRef(dark);
  useEffect(() => {
    darkRef.current = dark;
  });

  const attach = useCallback((search: SearchAddon) => {
    addon.current = search;
    const sub = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    return () => {
      sub.dispose();
      addon.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const selection = term.current?.getSelection().trim() ?? "";
    if (selection && !selection.includes("\n")) setQuery(selection);
    setOpen((current) => ({ token: (current?.token ?? 0) + 1 }));
  }, [term]);

  const close = useCallback(() => {
    addon.current?.clearDecorations();
    setOpen(null);
    setResults(NO_RESULTS);
    term.current?.focus();
  }, [term]);

  const step = useCallback(
    (delta: number) => {
      if (!addon.current || !query) return;
      const options = { decorations: decorations(darkRef.current()) };
      if (delta < 0) addon.current.findPrevious(query, options);
      else addon.current.findNext(query, options);
    },
    [query],
  );

  // An open field re-runs on every keystroke; `incremental` holds the current match.
  useEffect(() => {
    if (!addon.current) return;
    if (!open || !query) {
      addon.current.clearDecorations();
      return;
    }
    addon.current.findNext(query, { incremental: true, decorations: decorations(darkRef.current()) });
  }, [open, query]);

  return { attach, open, query, setQuery, results, start, close, step };
}
