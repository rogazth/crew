import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import {
  DEFAULT_ACCESS,
  DEFAULT_PROVIDER,
  fitChoice,
  parseAgentChoice,
  pickProvider,
  type AgentChoice,
} from "../lib/providers";
import { useInstalledProviders } from "./useInstalledProviders";

const KEY = "providers:default";
const LAST_KEY = "providers:last";

/** The last pick made on each provider, so coming back to one finds its model, effort and access as left. */
let lastByProvider: Record<string, AgentChoice> = {};

let preferred: AgentChoice = fitChoice({ provider: DEFAULT_PROVIDER, model: "", effort: "", access: DEFAULT_ACCESS });
/** What the start screen's composer holds while it is open: a pick for the next session that leaves `preferred` alone. */
let draft: AgentChoice | null = null;
let requested = false;
const listeners = new Set<() => void>();

function publish(next: AgentChoice) {
  preferred = next;
  for (const listener of listeners) listener();
}

function publishDraft(next: AgentChoice | null) {
  draft = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What ⌘N, Home's composer and a new agent start with: the preferred agent set
 * in Settings. `preferred` is that pick; `effective` swaps in an installed
 * provider when that CLI is missing. A pick made in a composer is a `draft`:
 * it is remembered per provider but never replaces the preferred agent.
 */
export function useDefaultAgent(refresh?: unknown) {
  const installed = useInstalledProviders(refresh);
  const current = useSyncExternalStore(subscribe, () => preferred);
  const currentDraft = useSyncExternalStore(subscribe, () => draft);

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
    api
      .stateGet(LAST_KEY)
      .then((raw) => {
        const parsed: unknown = JSON.parse(raw ?? "{}");
        if (typeof parsed !== "object" || parsed === null) return;
        for (const value of Object.values(parsed)) {
          const choice = parseAgentChoice(JSON.stringify(value));
          // A pick made before this was read wins over the stored one.
          if (choice && !lastByProvider[choice.provider]) lastByProvider[choice.provider] = choice;
        }
      })
      .catch(() => {});
  }, []);

  const update = useCallback((next: AgentChoice) => {
    publish(next);
    lastByProvider = { ...lastByProvider, [next.provider]: next };
    void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
    void api.stateSet(LAST_KEY, JSON.stringify(lastByProvider)).catch(() => {});
  }, []);

  /** A composer's pick for the next session: kept per provider, the preferred agent untouched. Null drops it. */
  const setDraft = useCallback((next: AgentChoice | null) => {
    publishDraft(next);
    if (!next) return;
    lastByProvider = { ...lastByProvider, [next.provider]: next };
    void api.stateSet(LAST_KEY, JSON.stringify(lastByProvider)).catch(() => {});
  }, []);

  /** What this provider was last used with, else its own default model, effort and access. */
  const lastOf = useCallback(
    (provider: AgentChoice["provider"]): AgentChoice =>
      lastByProvider[provider] ?? fitChoice({ ...preferred, provider, model: "", effort: "", serviceTier: "" }),
    [],
  );

  const effective = pickProvider(current, installed);
  return { preferred: current, effective, draft: currentDraft ?? effective, installed, update, setDraft, lastOf };
}
