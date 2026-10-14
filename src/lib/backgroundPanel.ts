/**
 * What a session's background panel lists (plan Part B, decisions 33–36, and
 * the orchestration plan's decisions 1–4): one list of the work a session
 * started. It merges four sources: the commands and subagents on its board,
 * the Crew children it owns, the sessions it launched, and the Crew processes
 * it started. Pure: the caller passes what it
 * holds, and gets the entries back in the order the panel shows them.
 */
import { isRunning } from "./background";
import { tokenCount } from "./contextMeter";
import { summarize } from "./activity";
import { EFFORT_LABELS, modelLabel, type Effort } from "./providers";
import { childState, isOwnedChild, pairThread, partyOf, type ChildState, type Party, type ThreadRef } from "./letters";
import type { BackgroundCommand, BackgroundKind, BackgroundList, BackgroundState, BotRef, Process, ProcessRun, ThreadPair } from "./protocol";
import { duration } from "./time";
import type { Session } from "./types";

/**
 * What an entry is: a subagent (native or Crew's, one kind), an independent
 * session the session launched, a shell or monitor, or a Crew process.
 */
export type PanelKind = "subagent" | "session" | "shell" | "process";

/** What differs underneath: how it stops and whether it can be written to, never how it looks. */
export type PanelOrigin = "native" | "crew";

/** An agent waiting on an answer is still running; this says what it waits for. */
export type PanelAttention = "question" | "approval";

export type PanelState = "running" | "done" | "failed" | "stopped";

/** What opening an entry shows: a command of the session's board, a child session, or a process run in one worktree. */
export type PanelSource = { type: "command"; id: string } | { type: "session"; id: string } | { type: "process"; id: string; worktree: string | null };

export type PanelEntry = {
  /** Unique within the panel. */
  id: string;
  kind: PanelKind;
  origin: PanelOrigin;
  /** Whether the user may write to it: a Crew subagent that has not exited, and an independent session. */
  writable: boolean;
  /** Set while the agent waits on a question or an approval; its state is still running. */
  attention?: PanelAttention;
  /** The shell command, the subagent's description, the child's name or the process's name. */
  title: string;
  detail: string;
  /** What a row shows after a title that does not say what runs: a nameless shell's command, in one line. */
  preview?: string;
  state: PanelState;
  startedAt: number;
  endedAt?: number;
  /** Absent when the source does not report it: the panel shows nothing rather than a zero. */
  tokens?: number;
  window?: number;
  model?: string;
  /** The reasoning effort it runs at, when its source says: Claude's native subagents never do. */
  effort?: string;
  activity?: string;
  stoppable: boolean;
  /** Why it cannot be stopped alone, or why it stopped when nobody asked. */
  stopNote?: string;
  /** The CLI's mark: a native subagent wears its parent's. */
  provider?: string;
  /** The tool call that started it, for a native subagent: where the transcript draws its card. */
  callId?: string;
  source: PanelSource;
};

export type PanelSummary = {
  running: { agents: number; sessions: number; shells: number; processes: number };
  /** Entries that have ended, whatever ended them. */
  finished: number;
  /** How many entries wait on the user's answer. */
  attention: number;
  /** What the status line says first: "scout asks", "2 waiting on you", "" when nothing waits. */
  attentionText: string;
  /** The folded line: "2 agents · 1 session · 1 shell", what runs or, when nothing does, what ran; "" when empty. */
  text: string;
};

const BOARD_KIND: Record<BackgroundKind, PanelKind> = { subagent: "subagent", shell: "shell", monitor: "shell" };

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

/** The panel's id for a board command, from the command's own. */
export const commandEntryId = (commandId: string): string => `command:${commandId}`;

/**
 * A shell's name for a header or a row: what the model said it is for, else
 * just "Shell". Commands run long; the whole one is in the thread's body.
 */
export function shellLabel(command: Pick<BackgroundCommand, "description">): string {
  return command.description?.trim() || "Shell";
}

const CD_PREFIX = /^\(?\s*cd\s+\S+\s*&&\s*/;

/** A command in one line for a row: its first line without the `cd dir &&` it opens with. */
export function commandPreview(command: string): string {
  let line = (command.split("\n").find((l) => l.trim()) ?? "").trim();
  for (let bare = line.replace(CD_PREFIX, ""); bare !== line; bare = line.replace(CD_PREFIX, "")) line = bare;
  return line.replace(/\s+/g, " ") || command.trim();
}

function fromCommand(command: BackgroundCommand, live: boolean, provider: string): PanelEntry {
  const kind = BOARD_KIND[command.kind];
  const shell = kind === "shell";
  const said = shell && !!command.description?.trim();
  // A shell with no name of its own keeps its command for the row's tooltip.
  return {
    id: commandEntryId(command.id),
    kind,
    origin: "native",
    writable: false,
    title: shell ? shellLabel(command) : command.command,
    detail: said ? "" : shell ? command.command : (command.description ?? ""),
    state: BOARD_STATE[command.state],
    startedAt: command.startedAt,
    ...present({
      preview: shell && !said ? commandPreview(command.command) : undefined,
      endedAt: command.endedAt,
      tokens: command.tokens,
      window: command.window,
      model: command.model,
      effort: command.effort,
      activity: command.activity,
      // A native subagent is the parent's own CLI at work.
      provider: kind === "subagent" ? provider : undefined,
      callId: command.toolCallId,
    }),
    stoppable: stoppableOf(command, live),
    ...present({ stopNote: command.stopNote }),
    source: { type: "command", id: command.id },
  };
}

const ATTENTION: Partial<Record<ChildState, PanelAttention>> = { question: "question", approval: "approval" };

/** A Crew subagent the session owns, or an independent session it launched. */
function fromChild(session: Session, kind: "subagent" | "session"): PanelEntry {
  const reason = childState(session);
  const state = CHILD_STATE[reason];
  return {
    id: `session:${session.id}`,
    kind,
    origin: "crew",
    // A subagent that exited has no process to hear it; a session of the user's is always theirs to write to.
    writable: kind === "session" || reason !== "exited",
    title: session.name,
    detail: session.description,
    state,
    startedAt: session.createdAt,
    ...present({
      attention: ATTENTION[reason],
      endedAt: state === "running" ? undefined : (session.lastEvent?.at ?? session.updatedAt),
      model: session.model || undefined,
      effort: session.effort || undefined,
      provider: session.provider,
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
    origin: "crew",
    writable: false,
    title: process.name,
    detail: process.command,
    state,
    startedAt,
    stoppable: state === "running",
    source: { type: "process", id: process.id, worktree: run.worktree },
  };
}

/** How an entry sorts: waiting on the user, then running, then ended. */
const rank = (entry: PanelEntry) => (entry.attention ? 0 : entry.state === "running" ? 1 : 2);

/**
 * Every entry of a session's panel, the one list its status line, sheet and
 * transcript read: its board's commands and subagents, the Crew subagents it
 * owns, the independent sessions it launched (`launchedBy`; one launched by
 * someone else is not its work), and the process runs it started. Attention
 * first, then running, then ended, newest first in each. A run that never
 * started has no time to show, so it is left out.
 */
export function panelEntries(
  board: BackgroundList | null,
  children: readonly Session[],
  processes: readonly Process[],
  parent: Pick<Session, "id" | "provider">,
): PanelEntry[] {
  const live = board?.live ?? false;
  const entries: PanelEntry[] = [
    ...(board?.commands ?? []).map((command) => fromCommand(command, live, parent.provider)),
    ...children.flatMap((session) => {
      if (session.launchedBy === parent.id) return [fromChild(session, "session")];
      return session.parentId === parent.id && isOwnedChild(session) ? [fromChild(session, "subagent")] : [];
    }),
    ...processes.flatMap((process) =>
      process.runs.flatMap((run) => (run.startedBy === parent.id && run.startedAt !== null ? [fromRun(process, run, run.startedAt)] : [])),
    ),
  ];
  return entries.sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count > 1 ? many : one}`;

/** The panel's folded line, what waits on the user, and how many of each kind still run. */
export function panelSummary(entries: readonly PanelEntry[]): PanelSummary {
  const running = entries.filter((entry) => entry.state === "running");
  const count = (kind: PanelKind) => running.filter((entry) => entry.kind === kind).length;
  const agents = count("subagent");
  const sessions = count("session");
  const shells = count("shell");
  const processes = count("process");
  const finished = entries.length - running.length;

  const waiting = running.filter((entry) => entry.attention);
  const attentionText =
    waiting.length === 0
      ? ""
      : waiting.length > 1
        ? `${waiting.length} waiting on you`
        : `${waiting[0]!.title} ${waiting[0]!.attention === "approval" ? "needs approval" : "asks"}`;

  // What runs, by kind; when nothing does, what there was, the same way.
  const shown = running.length > 0 ? running : entries;
  const all = (kind: PanelKind) => shown.filter((entry) => entry.kind === kind).length;
  const work: string[] = [];
  if (all("subagent") > 0) work.push(plural(all("subagent"), "agent"));
  if (all("session") > 0) work.push(plural(all("session"), "session"));
  if (all("shell") > 0) work.push(plural(all("shell"), "shell"));
  if (all("process") > 0) work.push(plural(all("process"), "process", "processes"));

  const text = work.join(" · ");
  return { running: { agents, sessions, shells, processes }, finished, attention: waiting.length, attentionText, text };
}

/**
 * The pairs the Conversations group lists: those whose other party is a bot
 * (no `kind`). A session, a terminal or the person is never a conversation;
 * a session is opened as an agent. A pair the session is not in (`with`) counts
 * when both of its parties are bots.
 */
export function botPairs(pairs: readonly ThreadPair[]): ThreadPair[] {
  const isBot = (ref: BotRef | undefined) => ref !== undefined && ref.kind === undefined;
  return pairs.filter((pair) => isBot(pair.peer) && (pair.with === undefined || isBot(pair.with)));
}

/** One row of the sheet's Conversations group: a pair of bots, the last letter's first line, and what opens it. */
export type ConversationEntry = {
  key: string;
  /** The other party: its face leads the row. */
  party: Party;
  label: string;
  /** "reviewer: first line of the last letter". */
  last: string;
  at: number;
  thread: ThreadRef;
};

/** The Conversations group for a chat: bot pairs only, as the daemon sorted them (newest first). */
export function conversationsOf(pairs: readonly ThreadPair[], owner: Party): ConversationEntry[] {
  return botPairs(pairs).map((pair) => {
    const thread = pairThread(pair, owner);
    return {
      key: `${pair.peer.id}:${pair.with?.id ?? ""}`,
      party: thread.peer,
      label: thread.label,
      last: `${partyOf(pair.last.from).name}: ${summarize(pair.last.text)}`,
      at: pair.last.at,
      thread: { a: thread.a, b: thread.b },
    };
  });
}

/** What each kind is called in a row's second line and an opened entry's header. */
export const KIND_LABEL: Record<PanelKind, string> = { subagent: "Subagent", session: "Session", shell: "Shell", process: "Process" };

/**
 * A row's second line: the kind and its model, then how long it has run, or how it ended and
 * after how long. A source that never says when it ended (a process) names its
 * state alone; a note on why it ended is kept at the end.
 */
export function entryDetail(entry: PanelEntry, now: number): string {
  const model = modelLine(entry);
  const kind = model ? `${KIND_LABEL[entry.kind]} · ${model}` : KIND_LABEL[entry.kind];
  if (entry.state === "running") return `${kind} · ${duration(now - entry.startedAt)}`;
  const ended = entry.endedAt === undefined ? entry.state : `${entry.state} after ${duration(entry.endedAt - entry.startedAt)}`;
  return `${kind} · ${ended}${entry.stopNote ? ` · ${entry.stopNote}` : ""}`;
}

/**
 * "Haiku 5.5 · high": the model as the picker names it, and the effort when
 * known; null when the source names no model. An id Crew does not list is
 * kept as is, without the date a CLI stamps on it.
 */
export function modelLine(entry: PanelEntry): string | null {
  if (!entry.model) return null;
  const id = entry.model.replace(/-\d{8}$/, "");
  const model = entry.provider ? modelLabel(entry.provider, id) : id;
  const effort = entry.effort && (EFFORT_LABELS[entry.effort as Effort]?.toLowerCase() ?? entry.effort);
  return effort ? `${model} · ${effort}` : model;
}

/** "41k tokens" for an entry whose source counts them; null when it does not, or none were used. */
export function tokensLabel(entry: PanelEntry): string | null {
  return entry.tokens !== undefined && entry.tokens > 0 ? `${tokenCount(entry.tokens)} tokens` : null;
}

/** What hovering the tokens says: out of how many, when the source knows its window. */
export function tokensTitle(entry: PanelEntry): string {
  return entry.tokens !== undefined && entry.window ? `${tokenCount(entry.tokens)} of its ${tokenCount(entry.window)} context` : "Tokens used";
}

/** The row after `step` rows down (up is negative), stopping at the ends. */
export function stepCursor(at: number, step: -1 | 1, count: number): number {
  return Math.max(0, Math.min(count - 1, at + step));
}

/**
 * The key of an ended entry that the daemon does not keep (a child, a process
 * run): the user clears it from the panel, and it comes back only if it ends
 * again or runs again, which changes this key.
 */
export const clearedKey = (entry: PanelEntry): string => `${entry.id}@${entry.endedAt ?? entry.startedAt}`;

/** The board's own entries are dropped by the daemon when cleared; the others are only hidden here. */
const onBoard = (entry: PanelEntry) => entry.source.type === "command";

/** The entries the panel shows: everything running, and what the user has not cleared. */
export function visibleEntries(entries: readonly PanelEntry[], cleared: ReadonlySet<string>): PanelEntry[] {
  return entries.filter((entry) => entry.state === "running" || onBoard(entry) || !cleared.has(clearedKey(entry)));
}

/** The keys Clear finished adds: every ended entry the daemon does not clear itself. */
export function finishedKeys(entries: readonly PanelEntry[]): string[] {
  return entries.filter((entry) => entry.state !== "running" && !onBoard(entry)).map(clearedKey);
}
