/**
 * What a session's background panel lists (plan Part B, decisions 33–36): one
 * list of the work a session left running or finished. It merges three
 * sources: the commands and subagents on its board, the Crew children it
 * started, and the Crew processes it started. Pure: the caller passes what it
 * holds, and gets the entries back in the order the panel shows them.
 */
import { isRunning } from "./background";
import { childState, isOwnedChild, type ChildState } from "./letters";
import type { BackgroundCommand, BackgroundKind, BackgroundList, BackgroundState, Process, ProcessRun } from "./protocol";
import type { Session } from "./types";

/** What an entry is: a subagent, a Crew subagent, a shell, or a Crew process. */
export type PanelKind = "agent" | "crew" | "shell" | "process";

export type PanelState = "running" | "done" | "failed" | "stopped";

/** What opening an entry shows: a command of the session's board, a child session, or a process run in one worktree. */
export type PanelSource = { type: "command"; id: string } | { type: "session"; id: string } | { type: "process"; id: string; worktree: string | null };

export type PanelEntry = {
  /** Unique within the panel. */
  id: string;
  kind: PanelKind;
  /** The shell command, the subagent's description, the child's name or the process's name. */
  title: string;
  detail: string;
  state: PanelState;
  startedAt: number;
  endedAt?: number;
  /** Absent when the source does not report it: the panel shows nothing rather than a zero. */
  tokens?: number;
  window?: number;
  model?: string;
  activity?: string;
  stoppable: boolean;
  /** Why it cannot be stopped alone, or why it stopped when nobody asked. */
  stopNote?: string;
  provider?: string;
  source: PanelSource;
};

export type PanelSummary = {
  running: { agents: number; shells: number; processes: number };
  /** Entries that have ended, whatever ended them. */
  finished: number;
  /** The folded line: "2 agents · 1 shell", "3 finished" when nothing runs, "" when empty. */
  text: string;
};

const BOARD_KIND: Record<BackgroundKind, PanelKind> = { subagent: "agent", shell: "shell", monitor: "shell" };

const BOARD_STATE: Record<BackgroundState, PanelState> = { running: "running", completed: "done", failed: "failed", stopped: "stopped" };

const CHILD_STATE: Record<ChildState, PanelState> = {
  working: "running",
  starting: "running",
  question: "running",
  approval: "running",
  reported: "done",
  failed: "failed",
  stopped: "stopped",
  exited: "stopped",
};

/** Keeps each optional field out of an entry when its source has none, instead of setting it to undefined. */
function present<T extends object>(fields: T): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<{ [K in keyof T]: Exclude<T[K], undefined> }>;
}

/**
 * Whether a board command can be stopped on its own. The daemon's word when
 * it gave one; otherwise what the tray offers today: a running command while
 * its CLI is up. A command that has ended is never stoppable.
 */
export function stoppableOf(command: BackgroundCommand, live: boolean): boolean {
  return isRunning(command) && (command.stoppable ?? live);
}

function fromCommand(command: BackgroundCommand, live: boolean): PanelEntry {
  return {
    id: `command:${command.id}`,
    kind: BOARD_KIND[command.kind],
    title: command.command,
    detail: command.description ?? "",
    state: BOARD_STATE[command.state],
    startedAt: command.startedAt,
    ...present({
      endedAt: command.endedAt,
      tokens: command.tokens,
      window: command.window,
      model: command.model,
      activity: command.activity,
    }),
    stoppable: stoppableOf(command, live),
    ...present({ stopNote: command.stopNote }),
    source: { type: "command", id: command.id },
  };
}

function fromChild(session: Session): PanelEntry {
  const reason = childState(session);
  const state = CHILD_STATE[reason];
  return {
    id: `session:${session.id}`,
    kind: "crew",
    title: session.name,
    detail: session.description,
    state,
    startedAt: session.createdAt,
    ...present({
      endedAt: state === "running" ? undefined : (session.lastEvent?.at ?? session.updatedAt),
      model: session.model || undefined,
      provider: session.provider,
      stopNote: reason === "exited" ? "its CLI exited" : undefined,
    }),
    stoppable: state === "running",
    source: { type: "session", id: session.id },
  };
}

function processState(run: ProcessRun): PanelState {
  switch (run.state) {
    case "starting":
    case "running":
    case "paused":
      return "running";
    case "crashed":
      return "failed";
    case "stopped":
      return "stopped";
    case "exited":
      return run.exitCode === 0 ? "done" : run.exitCode === null ? "stopped" : "failed";
  }
}

function fromRun(process: Process, run: ProcessRun, startedAt: number): PanelEntry {
  const state = processState(run);
  return {
    id: `process:${process.id}:${run.worktree ?? ""}`,
    kind: "process",
    title: process.name,
    detail: process.command,
    state,
    startedAt,
    stoppable: state === "running",
    source: { type: "process", id: process.id, worktree: run.worktree },
  };
}

/**
 * Every entry of a session's panel: its board's commands and subagents, the
 * Crew children it still owns, and the process runs it started. Running
 * entries come first, newest first; then the ended ones, newest first.
 * A run that never started has no time to show, so it is left out.
 */
export function panelEntries(
  board: BackgroundList | null,
  children: readonly Session[],
  processes: readonly Process[],
  sessionId: string,
): PanelEntry[] {
  const live = board?.live ?? false;
  const entries: PanelEntry[] = [
    ...(board?.commands ?? []).map((command) => fromCommand(command, live)),
    ...children.filter((session) => session.parentId === sessionId && isOwnedChild(session)).map(fromChild),
    ...processes.flatMap((process) =>
      process.runs.flatMap((run) => (run.startedBy === sessionId && run.startedAt !== null ? [fromRun(process, run, run.startedAt)] : [])),
    ),
  ];
  const rank = (entry: PanelEntry) => (entry.state === "running" ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
}

/** The panel's folded line, and how many of each kind still run. Crew children count as agents. */
export function panelSummary(entries: readonly PanelEntry[]): PanelSummary {
  const running = entries.filter((entry) => entry.state === "running");
  const agents = running.filter((entry) => entry.kind === "agent" || entry.kind === "crew").length;
  const shells = running.filter((entry) => entry.kind === "shell").length;
  const processes = running.filter((entry) => entry.kind === "process").length;
  const finished = entries.length - running.length;

  const work: string[] = [];
  if (agents > 0) work.push(`${agents} ${agents > 1 ? "agents" : "agent"}`);
  if (shells > 0) work.push(`${shells} ${shells > 1 ? "shells" : "shell"}`);
  if (processes > 0) work.push(`${processes} ${processes > 1 ? "processes" : "process"}`);

  const text = work.length > 0 ? work.join(" · ") : finished > 0 ? `${finished} finished` : "";
  return { running: { agents, shells, processes }, finished, text };
}
