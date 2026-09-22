import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  parseAgentChoice,
  pickProvider,
  type AgentChoice,
} from "../lib/providers";
import { useInstalledProviders } from "./useInstalledProviders";

const KEY = "providers:default";

let preferred: AgentChoice = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
let requested = false;
const listeners = new Set<() => void>();

function publish(next: AgentChoice) {
  preferred = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What ⌘N and a new agent start with. `preferred` is what the user picked;
 * `effective` swaps in an installed provider when that CLI is missing.
 */
export function useDefaultAgent(refresh?: unknown) {
  const installed = useInstalledProviders(refresh);
  const current = useSyncExternalStore(subscribe, () => preferred);

  useEffect(() => {
    if (requested) return;
    requested = true;
    api
      .stateGet(KEY)
      .then((raw) => {
        const stored = parseAgentChoice(raw);
        if (stored) publish(stored);
      })
      .catch(() => {});
  }, []);

  const update = useCallback((next: AgentChoice) => {
    publish(next);
    void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  return { preferred: current, effective: pickProvider(current, installed), installed, update };
}
