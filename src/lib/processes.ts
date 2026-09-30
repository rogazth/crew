import { DELETE, SEPARATOR, tidy, type MenuAction, type MenuEntry } from "./menu";
import type { Process, ProcessRun, ProcessSpec, ProcessState } from "./protocol";

export type { Process, ProcessRun, ProcessSpec } from "./protocol";

/** Up, or on its way up: the one state where Stop is the answer. */
export const isLive = (run: ProcessRun | undefined): boolean =>
  run !== undefined && (run.state === "running" || run.state === "paused" || run.state === "starting");

/** An agent wrote it or wants to change it, and the user has not said yes. */
export const awaitsUser = (process: Process): boolean => !process.approved || process.proposed !== null;

/** Its run in `worktree`; null is the main checkout. */
export const runIn = (process: Process, worktree: string | null): ProcessRun | undefined =>
  process.runs.find((run) => run.worktree === worktree);

/** Every run up right now, across the workspace's commands. */
export const liveRuns = (processes: Process[]): { process: Process; run: ProcessRun }[] =>
  processes.flatMap((process) => process.runs.flatMap((run) => (isLive(run) ? [{ process, run }] : [])));

/** What Start all starts in `worktree`: every approved command not already up there. */
export const startableIn = (processes: Process[], worktree: string | null): Process[] =>
  processes.filter((process) => process.approved && !isLive(runIn(process, worktree)));

/**
 * The env a run starts again with: a run that set its own over the command's
 * keeps it, so its port stays its own. Undefined takes the command's.
 */
export function rerunEnv(process: Process, run: ProcessRun | undefined): Record<string, string> | undefined {
  if (!run) return undefined;
  return Object.entries(run.env).some(([key, value]) => process.env[key] !== value) ? run.env : undefined;
}

/**
 * Left running by a session that is gone: nobody is watching it but the user.
 * `sessionIds` are the sessions that still exist.
 */
export const isOrphan = (run: ProcessRun, sessionIds: ReadonlySet<string>): boolean =>
  isLive(run) && run.startedBy !== null && !sessionIds.has(run.startedBy);

/** A new row goes to the end, as the daemon orders it; a known one keeps its place. */
export function upsertProcess(list: Process[], next: Process): Process[] {
  const index = list.findIndex((process) => process.id === next.id);
  if (index === -1) return [...list, next];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

export function removeProcess(list: Process[], id: string): Process[] {
  return list.some((process) => process.id === id) ? list.filter((process) => process.id !== id) : list;
}

export type ProcessEvent = { kind: "changed"; process: Process } | { kind: "removed"; id: string };

/**
 * A list the daemon answered, with the events heard while it was on its way
 * laid over it in order: the answer was read before some of them happened,
 * and must not wind a row back to before them.
 */
export function replayEvents(list: Process[], events: ProcessEvent[]): Process[] {
  return events.reduce(
    (rows, event) => (event.kind === "changed" ? upsertProcess(rows, event.process) : removeProcess(rows, event.id)),
    list,
  );
}

/** How a run stands; no run at all is a command that is stopped. */
export function stateLabel(run: ProcessRun | undefined): string {
  switch (run?.state ?? "stopped") {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "starting":
      // A restart waits out its backoff in this state; say which.
      return run && run.restarts > 0 ? "Restarting…" : "Starting…";
    case "exited":
      return run?.exitCode == null ? "Stopped by a signal" : `Exited with code ${run.exitCode}`;
    case "crashed":
      return "Crashed";
    case "stopped":
      return "Stopped";
  }
}

export type Tone = "success" | "warning" | "danger" | "quiet";

/** The dot beside a run: green up, amber in between, red down on its own. */
export function stateTone(run: ProcessRun | undefined): Tone {
  const state: ProcessState = run?.state ?? "stopped";
  switch (state) {
    case "running":
      return "success";
    case "paused":
    case "starting":
      return "warning";
    case "crashed":
      return "danger";
    case "exited":
      return run?.exitCode === 0 ? "quiet" : "danger";
    case "stopped":
      return "quiet";
  }
}

const START: MenuAction = { id: "start", label: "Start", icon: "play", hotkey: "S" };
const STOP: MenuAction = { id: "stop", label: "Stop", icon: "stop", hotkey: "S" };
const RESTART: MenuAction = { id: "restart", label: "Restart", icon: "reopen", hotkey: "R" };
const RESUME: MenuAction = { id: "resume", label: "Resume", icon: "play", hotkey: "P" };
const LOGS: MenuAction = { id: "logs", label: "Open Logs", icon: "terminal", hotkey: "L" };
const APPROVE: MenuAction = { id: "approve", label: "Approve", icon: "read", hotkey: "A" };
const REJECT: MenuAction = { id: "reject", label: "Reject", icon: "close", hotkey: "X" };
const EDIT_PROCESS: MenuAction = { id: "edit", label: "Edit…", icon: "edit", hotkey: "E" };
const COPY_COMMAND: MenuAction = { id: "copy-command", label: "Copy Command", icon: "copy", hotkey: "C" };

/** What a right-click on a command offers: the decision it waits on first, then the definition. */
export function processActions(process: Process): MenuEntry[] {
  return tidy([
    ...(awaitsUser(process) ? [APPROVE, REJECT, SEPARATOR] : []),
    EDIT_PROCESS,
    COPY_COMMAND,
    SEPARATOR,
    DELETE,
  ]);
}

/** What one run offers, by how it stands. Pausing is left to agents; one they paused, the user can still wake. */
export function runActions(process: Process, run: ProcessRun | undefined): MenuEntry[] {
  const live = isLive(run);
  return tidy([
    ...(live ? [STOP] : process.approved ? [START] : []),
    ...(run?.state === "running" || run?.state === "paused" ? [RESTART] : []),
    ...(run?.state === "paused" ? [RESUME] : []),
    SEPARATOR,
    LOGS,
  ]);
}

/** `KEY=value` a line, the way a `.env` reads. */
export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export type ParsedEnv = { env: Record<string, string>; error: null } | { env: null; error: string };

/** Blank lines and `#` comments are skipped; a leading `export ` is allowed, as in a shell file. */
export function parseEnv(text: string): ParsedEnv {
  const env: Record<string, string> = {};
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    const key = at === -1 ? line : line.slice(0, at).trim();
    if (at <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { env: null, error: `Line ${index + 1}: write it as NAME=value` };
    }
    let value = line.slice(at + 1).trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);
    env[key] = value;
  }
  return { env, error: null };
}

export type SpecChange = { field: string; before: string; after: string };

const FIELDS: { key: keyof ProcessSpec; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "command", label: "Command" },
  { key: "cwd", label: "Folder" },
  { key: "env", label: "Environment" },
  { key: "autoRestart", label: "Restart on crash" },
];

function show(value: ProcessSpec[keyof ProcessSpec]): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value;
  return formatEnv(value as Record<string, string>);
}

/** What an agent's proposal would change, field by field, for the user to read before saying yes. */
export function specChanges(current: ProcessSpec, proposed: ProcessSpec): SpecChange[] {
  return FIELDS.flatMap(({ key, label }) => {
    const before = show(current[key]);
    const after = show(proposed[key]);
    return before === after ? [] : [{ field: label, before, after }];
  });
}

export function specOf(process: Process): ProcessSpec {
  return {
    name: process.name,
    command: process.command,
    cwd: process.cwd,
    env: process.env,
    autoRestart: process.autoRestart,
  };
}
