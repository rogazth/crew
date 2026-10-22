import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import type { ProviderStatus } from "../lib/protocol";
import { useEnvStates } from "./useEnvLinks";

export interface ProviderStatusState {
  /** Null until the machine first answers (or when it never does). */
  providers: ProviderStatus[] | null;
  loading: boolean;
  /** Ask again, bypassing the daemon's caches (after an install, update or sign-in). */
  refresh: () => Promise<ProviderStatus[] | null>;
}

// The last answer per machine, so a page reopened shows it while it asks again.
const known = new Map<string, ProviderStatus[]>();
const watchers = new Set<() => void>();
let version = 0;

function remember(envId: string, found: ProviderStatus[]) {
  known.set(envId, found);
  version += 1;
  watchers.forEach((watcher) => watcher());
}

function watch(watcher: () => void) {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

// One CLI being asked about again, per machine, so the page and the nav share a request.
const asking = new Map<string, Promise<ProviderStatus | null>>();

/**
 * Asks machine `envId` about one CLI again, past the daemon's caches, and
 * folds the answer into what is known of that machine. Quick: a job that ended
 * does not wait on the other CLIs (cursor-agent's lookups take seconds).
 */
export function refreshProvider(envId: string, provider: string): Promise<ProviderStatus | null> {
  const key = `${envId}\n${provider}`;
  const pending = asking.get(key);
  if (pending) return pending;
  const ask = api
    .providerStatus(envId, true, [provider])
    .then((found) => {
      const fresh = found.find((p) => p.id === provider) ?? null;
      const have = known.get(envId);
      if (fresh && have) remember(envId, have.map((p) => (p.id === provider ? fresh : p)));
      return fresh;
    })
    .catch(() => null)
    .finally(() => asking.delete(key));
  asking.set(key, ask);
  return ask;
}

/** The agent CLIs on machine `envId`: installed, version, update, account. */
export function useProviderStatus(envId: string): ProviderStatusState {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(known.get(envId) ?? null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (refresh: boolean, alive: () => boolean = () => true): Promise<ProviderStatus[] | null> => {
      setLoading(true);
      try {
        const found = await api.providerStatus(envId, refresh);
        remember(envId, found);
        if (alive()) setProviders(found);
        return found;
      } catch {
        // A machine that is away keeps its last answer.
        return null;
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
    // One CLI asked about again (`refreshProvider`) lands here too.
    const off = watch(() => {
      const found = known.get(envId);
      if (alive && found) setProviders(found);
    });
    return () => {
      alive = false;
      off();
    };
  }, [envId, load]);

  const refresh = useCallback(() => load(true), [load]);
  return { providers, loading, refresh };
}

export type Attention = {
  /** CLIs with an update waiting, plus CLIs installed but signed out, on machines that are connected. */
  count: number;
  /** One of them is signed out: the row asks for more than a nudge. */
  signedOut: boolean;
};

/** What the nav's Providers row counts, across every connected machine. */
export function useProviderAttention(): Attention {
  const links = useEnvStates();
  useSyncExternalStore(watch, () => version);
  const reachable = links.filter((link) => link.status === "online" && !link.mismatch).map((link) => link.id);
  const key = reachable.join("|");
  // A failed read is tried again the next time the machine comes back (its key changes).
  useEffect(() => {
    const ids = key ? key.split("|") : [];
    for (const envId of ids) {
      if (known.has(envId)) continue;
      api
        .providerStatus(envId, false)
        .then((found) => remember(envId, found))
        .catch(() => {});
    }
    // A job that ends changes what its CLI reports (installed, update, account): the counts follow.
    const offJob = api.onProviderJob((job, envId) => {
      if (job.phase === "running" || !ids.includes(envId)) return;
      void refreshProvider(envId, job.provider);
    });
    return offJob;
  }, [key]);
  let count = 0;
  let signedOut = false;
  for (const envId of reachable) {
    for (const p of known.get(envId) ?? []) {
      if (!p.installed) continue;
      const out = p.account?.signedIn === false;
      if (out) signedOut = true;
      if (out || p.updateAvailable) count += 1;
    }
  }
  return { count, signedOut };
}
