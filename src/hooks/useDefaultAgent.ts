import { useCallback, useMemo, useSyncExternalStore } from "react";
import { sessionAccess } from "../lib/permissions";
import { defaultAgentSetting, fitChoice, lastAgentsSetting, pickProvider, type AgentChoice } from "../lib/providers";
import { peekSetting, saveSetting, useSetting } from "../lib/settingsEngine/store";
import { useInstalledProviders } from "./useInstalledProviders";

/** What the start screen's composer holds while it is open: a pick for the next session that leaves `preferred` alone. */
let draft: AgentChoice | null = null;
const listeners = new Set<() => void>();

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

function remember(next: AgentChoice) {
  saveSetting(lastAgentsSetting, { ...peekSetting(lastAgentsSetting), [next.provider]: next });
}

/**
 * What ⌘N, Home's composer and a new agent start with: the preferred agent set
 * in Settings. `preferred` is that pick; `effective` swaps in an installed
 * provider when that CLI is missing. A pick made in a composer is a `draft`:
 * it is remembered per provider but never replaces the preferred agent.
 */
export function useDefaultAgent(refresh?: unknown) {
  const installed = useInstalledProviders(refresh);
  const saved = useSetting(defaultAgentSetting);
  // The access chosen for every session is what a new one starts with too.
  const access = useSetting(sessionAccess);
  const current = useMemo(() => (access ? fitChoice({ ...saved, access }) : saved), [saved, access]);
  const currentDraft = useSyncExternalStore(subscribe, () => draft);

  const update = useCallback((next: AgentChoice) => {
    saveSetting(defaultAgentSetting, next);
    remember(next);
  }, []);

  /** A composer's pick for the next session: kept per provider, the preferred agent untouched. Null drops it. */
  const setDraft = useCallback((next: AgentChoice | null) => {
    publishDraft(next);
    if (next) remember(next);
  }, []);

  /** What this provider was last used with, else its own default model, effort and access. */
  const lastOf = useCallback(
    (provider: AgentChoice["provider"]): AgentChoice => {
      const last =
        peekSetting(lastAgentsSetting)[provider] ??
        fitChoice({ ...peekSetting(defaultAgentSetting), provider, model: "", effort: "", serviceTier: "" });
      const chosen = peekSetting(sessionAccess);
      return chosen ? fitChoice({ ...last, access: chosen }) : last;
    },
    [],
  );

  const effective = pickProvider(current, installed);
  return { preferred: current, effective, draft: currentDraft ?? effective, installed, update, setDraft, lastOf };
}
