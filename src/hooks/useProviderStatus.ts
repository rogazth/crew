import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import type { ProviderStatus } from "../lib/protocol";

export interface ProviderStatusState {
  /** Null until the machine first answers (or when it never does). */
  providers: ProviderStatus[] | null;
  loading: boolean;
  /** Ask again, bypassing the daemon's caches (after an install, update or sign-in). */
  refresh: () => Promise<void>;
}

// The last answer per machine, so a page reopened shows it while it asks again.
const known = new Map<string, ProviderStatus[]>();

/** The agent CLIs on machine `envId`: installed, version, update, account. */
export function useProviderStatus(envId: string): ProviderStatusState {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(known.get(envId) ?? null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (refresh: boolean, alive: () => boolean = () => true) => {
      setLoading(true);
      try {
        const found = await api.providerStatus(envId, refresh);
        known.set(envId, found);
        if (alive()) setProviders(found);
      } catch {
        // A machine that is away keeps its last answer.
      } finally {
        if (alive()) setLoading(false);
      }
    },
    [envId],
  );

  useEffect(() => {
    let alive = true;
    setProviders(known.get(envId) ?? null);
    void load(false, () => alive);
    return () => {
      alive = false;
    };
  }, [envId, load]);

  const refresh = useCallback(() => load(true), [load]);
  return { providers, loading, refresh };
}
