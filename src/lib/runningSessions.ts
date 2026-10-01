import { useEffect, useSyncExternalStore } from "react";
import { client } from "./client";
import type { PtyExit } from "./protocol";

/**
 * The terminal sessions whose CLI runs in a daemon, their tab open or not.
 * Closing a tab lets go of its terminal and leaves the process running, so the
 * window keeps track of what there is to stop: what it starts joins as it
 * starts, what a reload finds is asked of each workspace's daemon, and an exit
 * or a stop takes it out. By session id, each with its workspace.
 */
let running: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
/** Told of sessions the daemon stopped running with no exit sent: it restarted, and they went with it. */
const lostListeners = new Set<(sessionId: string) => void>();
/** The workspaces asked once already: a reconnect asks them again. */
const loaded = new Set<string>();
let bridged = false;

function publish(next: Map<string, string>) {
  running = next;
  for (const listener of listeners) listener();
}

/** The session and workspace a terminal's id names: `<workspace>[@<worktree>]/session:<id>`. */
export function sessionOfPty(id: string): { session: string; workspace: string } | null {
  const at = id.lastIndexOf("/session:");
  if (at < 0) return null;
  return { session: id.slice(at + "/session:".length), workspace: id.slice(0, at).split("@")[0] ?? "" };
}

export function markRunning(sessionId: string, workspaceId: string) {
  if (running.get(sessionId) === workspaceId) return;
  publish(new Map(running).set(sessionId, workspaceId));
}

export function markStopped(sessionId: string) {
  if (!running.has(sessionId)) return;
  const next = new Map(running);
  next.delete(sessionId);
  publish(next);
}

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

/** Whatever the daemon runs for `workspaceId` now replaces what the window thought. */
async function load(workspaceId: string): Promise<void> {
  loaded.add(workspaceId);
  const asked = running;
  // A crewd that predates closing without ending answers nothing: its terminals end with their tabs.
  const ids = await client.request<string[]>("sessions_running", { workspaceId }).catch(() => null);
  if (!ids) return;
  const answered = new Set(ids);
  const next = new Map(running);
  for (const id of answered) next.set(id, workspaceId);
  // What started while the daemon answered is not in its answer, and still runs.
  const lost: string[] = [];
  for (const [id, workspace] of asked) {
    if (workspace !== workspaceId || answered.has(id)) continue;
    next.delete(id);
    if (running.has(id)) lost.push(id);
  }
  // Before they leave the list, while whatever tracks them is still there to hear it.
  for (const id of lost) for (const listener of lostListeners) listener(id);
  publish(next);
}

/** `listener` hears of each session whose CLI the daemon no longer runs, though no exit said so. */
export function onSessionLost(listener: (sessionId: string) => void): () => void {
  lostListeners.add(listener);
  return () => {
    lostListeners.delete(listener);
  };
}

function bridge() {
  if (bridged) return;
  bridged = true;
  client.on("pty-exit", (payload) => {
    const owner = sessionOfPty((payload as PtyExit).id);
    if (owner) markStopped(owner.session);
  });
  // A daemon that came back may have restarted, and its terminals with it.
  client.onReconnect(() => {
    for (const workspaceId of loaded) void load(workspaceId);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const NONE: readonly string[] = [];

/** The running sessions, after asking each of `workspaceIds` once what it runs. */
export function useRunningSessions(workspaceIds: readonly string[] = NONE): ReadonlyMap<string, string> {
  const current = useSyncExternalStore(subscribe, () => running);
  const key = workspaceIds.join("\n");
  useEffect(() => {
    bridge();
    for (const workspaceId of key.split("\n")) {
      if (workspaceId && !loaded.has(workspaceId)) void load(workspaceId);
    }
  }, [key]);
  return current;
}
