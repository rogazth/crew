import { client } from "./client";
import type { BackgroundCommand, BackgroundList, SessionLive } from "./protocol";
import { elapsed } from "./time";
import type { Session } from "./types";

/**
 * What each session's turn left running in the background (plan §7e.10): the
 * tray above the composer, the marker where a command started, the count on
 * the tab. The daemon pushes `background-changed`; this keeps the latest per
 * session, read the first time a view asks.
 */

type Listener = () => void;

const lists = new Map<string, BackgroundList>();
/** Bumped by every list heard: a read that went out before one is older than it. */
const heard = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("background-changed", (payload) => set(payload as BackgroundList));
  client.onReconnect((here = () => true) => {
    for (const id of listeners.keys()) if (here(id)) void fetchList(id);
  });
}

function set(list: BackgroundList) {
  heard.set(list.sessionId, (heard.get(list.sessionId) ?? 0) + 1);
  lists.set(list.sessionId, list);
  for (const listener of listeners.get(list.sessionId) ?? []) listener();
}

async function fetchList(id: string): Promise<void> {
  const before = heard.get(id) ?? 0;
  try {
    const list = await client.request<BackgroundList>("background_list", { sessionId: id });
    if ((heard.get(id) ?? 0) === before) set(list);
  } catch {
    // A crewd that predates the tray has nothing to list.
  }
}

export function subscribeBackground(id: string, listener: Listener): () => void {
  ensureBridge();
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
    void fetchList(id);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}

export function readBackground(id: string): BackgroundList | null {
  return lists.get(id) ?? null;
}

// ——— What the views derive ————————————————————————————————————————————————

export const isRunning = (command: BackgroundCommand) => command.state === "running";

/** The tray's folded line: "2 running · 1 finished", or "nothing running". */
export function traySummary(commands: readonly BackgroundCommand[]): string {
  const running = commands.filter(isRunning).length;
  const finished = commands.length - running;
  const head = running > 0 ? `${running} running` : "nothing running";
  return finished > 0 ? `${head} · ${finished} finished` : head;
}

/**
 * What the tray of a turn Crew drives lists. The daemon clears the last
 * turn's commands when the next one starts (U3), so whatever it holds is the
 * running turn's, or the last one's once it is over.
 */
export function turnTray(list: BackgroundList | null): BackgroundCommand[] {
  return list?.commands ?? [];
}

/**
 * What a terminal's tray lists: what its last Stop hook said was still
 * running, read-only. A new turn hides it (U3): that Stop is the turn
 * before's, and the next one says what is left.
 */
export function terminalTray(live: SessionLive | null): BackgroundCommand[] {
  if (!live || live.working) return [];
  return live.backgroundTasks ?? [];
}

/**
 * The count on a session's tab: only once its turn is over (or answered and
 * waiting on them), with commands still running. While it works, the spinner
 * already says so.
 */
export function tabCount(list: BackgroundList | null, working: boolean): number {
  if (!list || (working && !list.waiting)) return 0;
  return list.commands.filter(isRunning).length;
}

/** A terminal's: what its last Stop hook named, once that turn is over. */
export function terminalCount(live: SessionLive | null): number {
  return terminalTray(live).filter(isRunning).length;
}

/** The count on a session's tab, from whichever list its kind keeps. */
export function tabBackgroundCount(
  session: Pick<Session, "kind" | "status">,
  list: BackgroundList | null,
  live: SessionLive | null,
): number {
  if (session.kind === "terminal") return terminalCount(live);
  return tabCount(list, session.status === "working" || session.status === "needs-input" || session.status === "starting");
}

/** One command's state, the way the tray's row says it. */
export function stateLabel(command: BackgroundCommand, now = Date.now()): string {
  switch (command.state) {
    case "running":
      return `running ${elapsed(command.startedAt, now)}`;
    case "stopped":
      return "stopped";
    case "failed":
      return command.exitCode !== undefined ? `exited ${command.exitCode}` : "failed";
    case "completed":
      return command.exitCode !== undefined ? `exited ${command.exitCode}` : "finished";
  }
}

/**
 * What a command printed, as plain text: its colours and cursor moves go, the
 * words stay. Claude hands the output escape sequences included.
 */
export function plainText(output: string): string {
  // eslint-disable-next-line no-control-regex
  const bare = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "");
  // A line redrawn with a carriage return (a progress bar) shows as it ended.
  return bare
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n");
}

/** The tool calls that started a command: where the transcript marks one. */
export function markedCalls(commands: readonly BackgroundCommand[]): Map<string, BackgroundCommand> {
  const out = new Map<string, BackgroundCommand>();
  for (const command of commands) if (command.toolCallId) out.set(command.toolCallId, command);
  return out;
}
