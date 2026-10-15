import type { BrowserLease } from "../protocol";

/**
 * Which tabs an agent is driving, as crewd announces them. A driven tab is
 * pinned: discarding its guest would pull the page out from under the agent.
 *
 * A tab main asked to mount counts as driven for a moment too. Its lease is
 * taken before the call reaches main, but the announcement and the request
 * travel separately, and the guest must not be built and dropped in between.
 */
export type LeaseStore = {
  get(tab: string): BrowserLease | null;
  /** Leased or summoned. The same set back until one of them changes. */
  held(): ReadonlySet<string>;
  /**
   * Takes one crewd's list, unless one numbered higher came first from it: an
   * event can overtake the reply to a list request, and the older of the two
   * would unpin a tab an agent has just taken. Unnumbered lists always apply.
   * Each daemon (`source`) leases its own workspaces' tabs; the store holds
   * them all.
   */
  set(leases: readonly BrowserLease[], seq?: number, source?: string): void;
  summon(tab: string): void;
  subscribe(cb: () => void): () => void;
};

/** Long enough for any mount to finish; the lease holds the tab after that. */
export const SUMMON_MS = 30_000;

export function createLeaseStore(
  now: () => number = Date.now,
  later: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
): LeaseStore {
  let leases = new Map<string, BrowserLease>();
  const bySource = new Map<string, readonly BrowserLease[]>();
  // crewd numbers from its clock, so a restarted daemon's lists still count as newer.
  const newest = new Map<string, number>();
  const summoned = new Map<string, number>();
  let held: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();

  const recompute = () => {
    const at = now();
    for (const [tab, until] of summoned) if (until <= at) summoned.delete(tab);
    const next = new Set([...leases.keys(), ...summoned.keys()]);
    const same = next.size === held.size && [...next].every((tab) => held.has(tab));
    if (!same) held = next;
    return !same;
  };
  const notify = () => {
    for (const cb of listeners) cb();
  };

  return {
    get: (tab) => leases.get(tab) ?? null,
    held: () => held,
    set: (list, seq, source = "local") => {
      if (seq !== undefined) {
        if (seq < (newest.get(source) ?? Number.NEGATIVE_INFINITY)) return;
        newest.set(source, seq);
      }
      bySource.set(source, list);
      const all = [...bySource.values()].flat();
      const before = leases;
      leases = new Map(all.map((lease) => [lease.tab, lease]));
      const moved =
        before.size !== leases.size ||
        all.some((lease) => {
          const old = before.get(lease.tab);
          return !old || old.holder !== lease.holder || old.sessionId !== lease.sessionId;
        });
      if (recompute() || moved) notify();
    },
    summon: (tab) => {
      summoned.set(tab, now() + SUMMON_MS);
      if (recompute()) notify();
      later(() => {
        if (recompute()) notify();
      }, SUMMON_MS);
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

export const leases = createLeaseStore();
