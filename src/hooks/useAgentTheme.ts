import { createContext, createElement, useCallback, useContext, useEffect, useState } from "react";
import * as api from "../lib/api";
import { DEFAULT_AGENT_THEME, parseAgentTheme, type AgentThemeId } from "../lib/agentTheme";

const KEY = "agent:theme";

type Value = { theme: AgentThemeId; update: (next: AgentThemeId) => void };

const Context = createContext<Value>({ theme: DEFAULT_AGENT_THEME, update: () => {} });

/** Picks which chat surface every agent tab renders; the settings page writes here. */
export function AgentThemeProvider({ children }: { children: React.ReactNode }) {
  const [saved, setSaved] = useState(DEFAULT_AGENT_THEME);
  // A pick made before the saved theme arrives wins over it.
  const [picked, setPicked] = useState<AgentThemeId | null>(null);
  const theme = picked ?? saved;

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => !cancelled && setSaved(parseAgentTheme(raw)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Exposed on the root so theme-scoped CSS can hang off `[data-agent-theme]`.
  useEffect(() => {
    document.documentElement.dataset.agentTheme = theme;
  }, [theme]);

  const update = useCallback((next: AgentThemeId) => {
    setPicked(next);
    void api.stateSet(KEY, next).catch(() => {});
  }, []);

  return createElement(Context.Provider, { value: { theme, update } }, children);
}

export const useAgentTheme = () => useContext(Context);
