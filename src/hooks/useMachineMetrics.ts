import { useEffect, useState } from "react";
import { machineMetrics } from "../lib/api";
import type { MachineSample } from "../lib/protocol";

export const METRICS_POLL_MS = 30_000;
/** What the daemon keeps: two hours at one sample every 30 s. */
export const METRICS_KEPT = 240;

/** `fresh` joined onto `kept`, oldest first, past the newest of `kept` and no more than the daemon keeps. */
export function mergeSamples(kept: MachineSample[], fresh: MachineSample[]): MachineSample[] {
  const last = kept.at(-1)?.at ?? -Infinity;
  const added = fresh.filter((sample) => sample.at > last);
  if (added.length === 0) return kept;
  return [...kept, ...added].slice(-METRICS_KEPT);
}

/**
 * A machine's recent CPU and memory samples, oldest first. The first call
 * fetches all of them; each poll after that asks only for what is newer. Empty
 * while the machine is offline: the samples already read stay.
 */
export function useMachineMetrics(envId: string | null): { samples: MachineSample[]; error: string | null } {
  const [state, setState] = useState<{ env: string | null; samples: MachineSample[]; error: string | null }>({
    env: envId,
    samples: [],
    error: null,
  });

  useEffect(() => {
    if (!envId) return;
    let live = true;
    let kept: MachineSample[] = [];
    setState({ env: envId, samples: [], error: null });
    const pull = async () => {
      try {
        const fresh = await machineMetrics(envId, kept.at(-1)?.at);
        if (!live) return;
        kept = mergeSamples(kept, fresh);
        setState({ env: envId, samples: kept, error: null });
      } catch (error) {
        if (live) setState({ env: envId, samples: kept, error: error instanceof Error ? error.message : String(error) });
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), METRICS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [envId]);

  // A render between a machine change and its effect must not show the old one's samples.
  return state.env === envId ? { samples: state.samples, error: state.error } : { samples: [], error: null };
}
