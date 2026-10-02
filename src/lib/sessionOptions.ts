import type { Access } from "./providers";
import type { Session } from "./types";

/**
 * What each session's CLI was started in, so the chat knows what a change to
 * the composer's chips still has to reach it. The row says what the user
 * wants; this says what runs.
 */
export type Launched = {
  model: string;
  effort: string;
  access: string;
  /** Settings bypassed permissions: the CLI ignores `access`, and ⇧Tab starts from bypass. */
  bypass: boolean;
};

type Listener = () => void;

const launched = new Map<string, Launched>();
const listeners = new Map<string, Set<Listener>>();

export function setLaunched(id: string, next: Launched): void {
  launched.set(id, next);
  for (const listener of listeners.get(id) ?? []) listener();
}

export function readLaunched(id: string): Launched | null {
  return launched.get(id) ?? null;
}

export function subscribeLaunched(id: string, listener: Listener): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}

/**
 * Claude's ⇧Tab walks its modes in this order, measured against Claude Code
 * 2.1.288 started without `--allow-dangerously-skip-permissions`. Plan has no
 * chip of its own; it is a stop on the way.
 */
const CLAUDE_CYCLE = ["ask", "edits", "plan", "auto"] as const;

/** How many ⇧Tab presses take Claude from one access to another; null when no number of them does. */
export function modePresses(from: string, to: string): number | null {
  const a = CLAUDE_CYCLE.indexOf(from as (typeof CLAUDE_CYCLE)[number]);
  const b = CLAUDE_CYCLE.indexOf(to as (typeof CLAUDE_CYCLE)[number]);
  if (a < 0 || b < 0) return null;
  return (b - a + CLAUDE_CYCLE.length) % CLAUDE_CYCLE.length;
}

/**
 * What a change to the row needs before the CLI runs it: nothing, ⇧Tab
 * presses (Claude's access, which lasts only the session), or a relaunch with
 * resume (model and effort: the CLIs' own `/model` and `/effort` would save
 * them as the user's default for every session after).
 */
export type Apply = { kind: "none" } | { kind: "keys"; presses: number } | { kind: "relaunch" };

export function applyFor(session: Pick<Session, "provider" | "model" | "effort" | "autonomy">, running: Launched | null): Apply {
  if (!running) return { kind: "none" };
  if (session.model !== running.model || session.effort !== running.effort) return { kind: "relaunch" };
  if (session.autonomy === running.access) return { kind: "none" };
  if (session.provider === "claude" && !running.bypass) {
    const presses = modePresses(running.access, session.autonomy);
    if (presses !== null) return { kind: "keys", presses };
  }
  // A bypassed CLI already runs without asking: what the row asks for waits for Settings.
  return running.bypass ? { kind: "none" } : { kind: "relaunch" };
}

/** The access ⇧Tab moves to in the chat: the provider's next mode, short of full. */
export function nextAccess(current: string, offered: Access[]): Access | null {
  const ring: Access[] = offered.filter((access) => access !== "full");
  if (ring.length < 2) return null;
  const at = ring.indexOf(current as Access);
  return ring[(at + 1) % ring.length] ?? null;
}
