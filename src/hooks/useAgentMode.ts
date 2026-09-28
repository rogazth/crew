import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { DEFAULT_AGENT_MODE, parseAgentMode, type AgentMode } from "../lib/agentMode";

const KEY = "agents:mode";

let mode: AgentMode = DEFAULT_AGENT_MODE;
let requested = false;
const listeners = new Set<() => void>();

function publish(next: AgentMode) {
  mode = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Chat or terminal for new agents; shared by the settings page and the agent sheet. */
export function useAgentMode() {
  const current = useSyncExternalStore(subscribe, () => mode);

  useEffect(() => {
    if (requested) return;
    requested = true;
    api
      .stateGet(KEY)
      .then((raw) => publish(parseAgentMode(raw)))
      .catch(() => {});
  }, []);

  const update = useCallback((next: AgentMode) => {
    if (next === mode) return;
    publish(next);
    void api.stateSet(KEY, next).catch(() => {});
  }, []);

  return { mode: current, update };
}
