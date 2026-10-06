import { useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { listedModelsVersion, loadListedModels, subscribeListedModels } from "../lib/providers";

/**
 * Reads the models a provider's CLI lists (cursor-agent's, Grok 4.7 the day it
 * ships) and re-renders once they arrive. Asks again when `refresh` changes,
 * at most every few minutes; until then, and when the CLI says nothing,
 * Crew's own list stands.
 */
export function useListedModels(provider: string, refresh?: unknown): void {
  useEffect(() => {
    loadListedModels(provider, api.listedModels);
  }, [provider, refresh]);
  useSyncExternalStore(subscribeListedModels, listedModelsVersion);
}
