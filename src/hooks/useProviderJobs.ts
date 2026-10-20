import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type {
  ProviderJob,
  ProviderJobAction,
  ProviderJobMethod,
  ProviderLoginEvent,
  ProviderLoginFlow,
} from "../lib/protocol";

export interface ProviderJobsState {
  /** The latest job per provider id: running, or the last one that ended. */
  jobs: Record<string, ProviderJob>;
  /** A provider with a job running. */
  busy: (provider: string) => boolean;
  /**
   * Run `action` on the machine's CLI. `method` is remembered per provider and
   * machine for next time (see `methodOf`). Rejects if a job already runs for it.
   */
  start: (provider: string, action: ProviderJobAction, method?: ProviderJobMethod) => Promise<ProviderJob>;
  cancel: (provider: string) => Promise<void>;
  /** Forget an ended job (dismiss its result). */
  clear: (provider: string) => void;
  /** The method last chosen for the provider on this machine, if any. */
  methodOf: (provider: string) => ProviderJobMethod | undefined;
  /** What to type in a terminal tab to sign in (`login`) or out (`logout`). */
  loginCommand: (provider: string) => Promise<{ login: string; logout: string }>;
  /** Codex's device-code sign-in: the code and URL to show; `loginEnd` says how it ended. */
  flow: ProviderLoginFlow | null;
  loginEnd: ProviderLoginEvent | null;
  startLogin: () => Promise<ProviderLoginFlow>;
  cancelLogin: () => Promise<void>;
}

const METHODS: readonly string[] = ["npm", "brew", "script", "native"];

// The last jobs per machine, so a page reopened mid-install shows it right away.
const known = new Map<string, Record<string, ProviderJob>>();

/**
 * Install, update, reinstall, uninstall and sign-out jobs on machine `envId`,
 * with their live progress. Call `useProviderStatus().refresh()` when one ends:
 * the daemon already dropped its caches, so the next read is fresh.
 */
export function useProviderJobs(envId: string, onSettled?: (job: ProviderJob) => void): ProviderJobsState {
  const [jobs, setJobs] = useState<Record<string, ProviderJob>>(known.get(envId) ?? {});
  const [methods, setMethods] = useState<Record<string, ProviderJobMethod>>({});
  const [flow, setFlow] = useState<ProviderLoginFlow | null>(null);
  const [loginEnd, setLoginEnd] = useState<ProviderLoginEvent | null>(null);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  const put = useCallback(
    (job: ProviderJob) => {
      setJobs((all) => {
        const next = { ...all, [job.provider]: job };
        known.set(envId, next);
        return next;
      });
    },
    [envId],
  );

  // A snapshot read before a live event can arrive after it: it must not take a job that has ended back to running.
  const putListed = useCallback(
    (job: ProviderJob) => {
      setJobs((all) => {
        const have = all[job.provider];
        if (have && have.id === job.id && have.phase !== "running") return all;
        const next = { ...all, [job.provider]: job };
        known.set(envId, next);
        return next;
      });
    },
    [envId],
  );

  useEffect(() => {
    let alive = true;
    setJobs(known.get(envId) ?? {});
    setFlow(null);
    setLoginEnd(null);
    const offJob = api.onProviderJob((job, env) => {
      if (env !== envId || !alive) return;
      put(job);
      if (job.phase !== "running") settled.current?.(job);
    });
    const offLogin = api.onProviderLogin((event, env) => {
      if (env !== envId || !alive) return;
      setFlow((current) => (current?.loginId === event.loginId ? null : current));
      setLoginEnd(event);
    });
    // A job started before this page opened (or while it was away).
    api
      .providerJobList(envId)
      .then((list) => {
        if (alive) for (const job of list) putListed(job);
      })
      .catch(() => {});
    return () => {
      alive = false;
      offJob();
      offLogin();
    };
  }, [envId, put, putListed]);

  // The remembered methods, read once per machine.
  useEffect(() => {
    let alive = true;
    const providers = ["claude", "codex", "cursor", "opencode"];
    void Promise.all(providers.map((p) => api.stateGet(api.providerMethodKey(envId, p)).catch(() => null))).then((values) => {
      if (!alive) return;
      const found: Record<string, ProviderJobMethod> = {};
      providers.forEach((provider, at) => {
        const value = values[at];
        if (value && METHODS.includes(value)) found[provider] = value as ProviderJobMethod;
      });
      setMethods(found);
    });
    return () => {
      alive = false;
    };
  }, [envId]);

  const start = useCallback(
    async (provider: string, action: ProviderJobAction, method?: ProviderJobMethod) => {
      const job = await api.providerJobStart(envId, provider, action, method);
      put(job);
      if (method && method !== "native") {
        setMethods((all) => ({ ...all, [provider]: method }));
        void api.stateSet(api.providerMethodKey(envId, provider), method).catch(() => {});
      }
      return job;
    },
    [envId, put],
  );

  const cancel = useCallback(
    async (provider: string) => {
      const job = jobs[provider];
      if (job?.phase === "running") await api.providerJobCancel(envId, job.id);
    },
    [envId, jobs],
  );

  const clear = useCallback(
    (provider: string) => {
      setJobs((all) => {
        if (all[provider]?.phase === "running") return all;
        const rest = Object.fromEntries(Object.entries(all).filter(([id]) => id !== provider));
        known.set(envId, rest);
        return rest;
      });
    },
    [envId],
  );

  const startLogin = useCallback(async () => {
    setLoginEnd(null);
    const started = await api.providerLoginStart(envId, "codex");
    setFlow(started);
    return started;
  }, [envId]);

  const cancelLogin = useCallback(async () => {
    if (flow) await api.providerLoginCancel(envId, flow.loginId);
  }, [envId, flow]);

  return {
    jobs,
    busy: (provider) => jobs[provider]?.phase === "running",
    start,
    cancel,
    clear,
    methodOf: (provider) => methods[provider],
    loginCommand: (provider) => api.providerLogin(envId, provider),
    flow,
    loginEnd,
    startLogin,
    cancelLogin,
  };
}
