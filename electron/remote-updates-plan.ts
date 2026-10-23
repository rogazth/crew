// When a machine's crewd is brought up to this Mac's, worked out without ssh
// or sockets so it can be tested. remote-updates.ts does the reaching.

import { compareVersions } from "../src/lib/remotes";

/** How long no session may have worked there before an update on its own starts. */
export const IDLE_FOR_MS = 2 * 60_000;
/** How long a version that failed, or was cancelled, on a machine is left before it goes on its own. */
export const RETRY_AFTER_MS = 6 * 60 * 60_000;

/** What the updater keeps about one machine between looks. */
export type Memory = {
  /** The user asked for the update once nothing works there. */
  queued: boolean;
  /** Since when the machine has had no session working, as last seen. */
  idleSince: number | null;
  /** The last version that failed to go there, or whose update the user cancelled. */
  heldBack: { version: string; at: number } | null;
};

export const FRESH: Memory = { queued: false, idleSince: null, heldBack: null };

export type Look = {
  /** What crewd there says it is; "" when it did not answer. */
  version: string;
  /** Its sessions mid-turn or waiting on an answer. */
  agentsRunning: number;
  /** This Mac's crewd version, the one the machine is brought to. */
  target: string;
  /** "Update machines automatically" is on. */
  auto: boolean;
  now: number;
};

/**
 * `none`: up to date, switched off, or a failure still fresh. `wait`: behind,
 * and a session works there or it has not been idle long enough. `update`: now.
 */
export type Decision = { action: "none" | "wait" | "update"; memory: Memory };

export function decide(look: Look, memory: Memory): Decision {
  // Never down: a second Mac on an older Crew leaves a newer machine alone.
  if (!look.version || !look.target || compareVersions(look.version, look.target) >= 0) {
    return { action: "none", memory: { ...memory, queued: false, idleSince: null } };
  }
  const held = memory.heldBack?.version === look.target && look.now - memory.heldBack.at < RETRY_AFTER_MS;
  if (!memory.queued && (!look.auto || held)) return { action: "none", memory: { ...memory, idleSince: null } };
  if (look.agentsRunning > 0) return { action: "wait", memory: { ...memory, idleSince: null } };
  // Asked for by the user, it goes as soon as the last session is done.
  if (memory.queued) return { action: "update", memory };
  const idleSince = memory.idleSince ?? look.now;
  if (look.now - idleSince >= IDLE_FOR_MS) return { action: "update", memory: { ...memory, idleSince } };
  return { action: "wait", memory: { ...memory, idleSince } };
}
