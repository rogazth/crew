// Brings each machine's crewd up to this Mac's once nothing works there: on
// its own when "Update machines automatically" is on, or when the user asked
// for an update to wait for the sessions to finish. The decisions are in
// remote-updates-plan.ts; this does the looking and the updating.

import type { RemoteEnv } from "../src/lib/protocol";
import type { RemoteUpdateResult, RemoteUpdateState } from "../src/lib/remotes";
import { decide, FRESH, type Memory } from "./remote-updates-plan";

/** How often every machine is looked at. */
export const LOOK_EVERY_MS = 30_000;
/** The first look after launch, once the window has had its links come up. */
const FIRST_LOOK_MS = 10_000;

type Deps = {
  machines(): Promise<RemoteEnv[]>;
  /** Its version and busy sessions; rejects when it does not answer. */
  peek(row: RemoteEnv): Promise<{ version: string; agentsRunning: number }>;
  /** This Mac's crewd version; null when it does not answer. */
  target(): Promise<string | null>;
  auto(): Promise<boolean>;
  /** Another job holds the machine: an update, restart or removal from the window. */
  busy(id: string): boolean;
  update(row: RemoteEnv): Promise<{ warning: string | null }>;
  publish(states: Record<string, RemoteUpdateState>): void;
  finished(result: RemoteUpdateResult): void;
};

export type RemoteUpdater = {
  start(): void;
  stop(): void;
  /** Looks at every machine now; a look already on its way is shared. */
  look(): Promise<void>;
  /** Updates the machine once no session works there. */
  queue(id: string): Promise<void>;
  /** Drops a queued or pending update; the automatic one leaves that version alone for a while. */
  cancel(id: string): void;
  states(): Record<string, RemoteUpdateState>;
};

export function remoteUpdater(deps: Deps): RemoteUpdater {
  const memory = new Map<string, Memory>();
  const states = new Map<string, RemoteUpdateState>();
  let looking: Promise<void> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let every: ReturnType<typeof setInterval> | null = null;

  const publish = () => deps.publish(Object.fromEntries(states));
  function set(id: string, state: RemoteUpdateState | null) {
    const before = JSON.stringify(states.get(id) ?? null);
    if (state) states.set(id, state);
    else states.delete(id);
    if (JSON.stringify(state) !== before) publish();
  }

  async function lookAll() {
    const [rows, target, auto] = await Promise.all([deps.machines(), deps.target(), deps.auto()]).catch(() => [null, null, false] as const);
    if (!rows || !target) return;
    const ids = new Set(rows.map((row) => row.id));
    for (const id of [...memory.keys()]) if (!ids.has(id)) memory.delete(id);
    for (const id of [...states.keys()]) if (!ids.has(id)) set(id, null);
    await Promise.all(rows.map((row) => lookAt(row, target, auto)));
  }

  async function lookAt(row: RemoteEnv, target: string, auto: boolean) {
    if (deps.busy(row.id) || states.get(row.id)?.state === "updating") return;
    // One that does not answer keeps what was known: it is looked at again next time.
    const seen = await deps.peek(row).catch(() => null);
    if (!seen || deps.busy(row.id)) return;
    const { action, memory: next } = decide({ ...seen, target, auto, now: Date.now() }, memory.get(row.id) ?? FRESH);
    memory.set(row.id, next);
    if (action === "none") return set(row.id, null);
    const state = { version: target, queued: next.queued, agentsRunning: seen.agentsRunning };
    if (action === "wait") return set(row.id, { state: "waiting", ...state });
    set(row.id, { state: "updating", ...state });
    try {
      const { warning } = await deps.update(row);
      memory.set(row.id, FRESH);
      deps.finished({ id: row.id, name: row.name, version: target, ok: true, message: warning });
    } catch (error) {
      memory.set(row.id, { ...FRESH, heldBack: { version: target, at: Date.now() } });
      deps.finished({ id: row.id, name: row.name, version: target, ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      set(row.id, null);
    }
  }

  function look(): Promise<void> {
    looking ??= lookAll().finally(() => {
      looking = null;
    });
    return looking;
  }

  return {
    start() {
      first = setTimeout(() => void look(), FIRST_LOOK_MS);
      every = setInterval(() => void look(), LOOK_EVERY_MS);
    },
    stop() {
      if (first) clearTimeout(first);
      if (every) clearInterval(every);
    },
    look,
    async queue(id) {
      memory.set(id, { ...(memory.get(id) ?? FRESH), queued: true, heldBack: null });
      // A look on its way may have read the memory before the queue: the next one starts after it.
      await looking;
      await look();
    },
    cancel(id) {
      const state = states.get(id);
      if (!state || state.state === "updating") return;
      memory.set(id, { ...FRESH, heldBack: { version: state.version, at: Date.now() } });
      set(id, null);
    },
    states: () => Object.fromEntries(states),
  };
}
