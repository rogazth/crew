import { DELETE, type MenuAction } from "./menu";
import type { Process, ProcessRun, ProcessSpec, ProcessState } from "./protocol";
import type { Session } from "./types";

export type { Process, ProcessRun, ProcessSpec } from "./protocol";

/** Up, or on its way up: the one state where Stop is the answer. */
export const isLive = (run: ProcessRun | undefined): boolean =>
  run !== undefined && (run.state === "running" || run.state === "paused" || run.state === "starting");

/** The local address a run printed, while it is up to answer there. */
export const servedUrl = (run: ProcessRun | undefined): string | null => (run && isLive(run) ? run.url : null);

/** An address on this machine: what a dev server prints, and what a browser here can open. */
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/** What a run serves, when a Crew browser tab here can open it. */
export function localUrl(run: ProcessRun | undefined): string | null {
  const url = servedUrl(run);
  return url !== null && LOCAL_URL.test(url) ? url : null;
}

/** An address as short as it reads: `localhost:5173`, its path only when it has one. */
export function urlLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** Its run in `worktree`; null is the main checkout. */
export const runIn = (process: Process, worktree: string | null): ProcessRun | undefined =>
  process.runs.find((run) => run.worktree === worktree);

/** Every run up right now, across the workspace's commands. */
export const liveRuns = (processes: Process[]): { process: Process; run: ProcessRun }[] =>
  processes.flatMap((process) => process.runs.flatMap((run) => (isLive(run) ? [{ process, run }] : [])));

/** What Start all starts in `worktree`: every command not already up there. */
export const startableIn = (processes: Process[], worktree: string | null): Process[] =>
  processes.filter((process) => !isLive(runIn(process, worktree)));

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

const EDIT_PROCESS: MenuAction = { id: "edit", label: "Edit", icon: "edit" };

/**
 * What a command's ⋯ offers: its definition. In a workspace of one worktree,
 * where no pill stands for the run, `run` puts the run's own actions first.
 */
export function processActions(run?: ProcessRun): MenuAction[] {
  // One list, no rules: few enough to read at a glance.
  return [...(run ? soloActions(run) : []), EDIT_PROCESS, DELETE];
}

/**
 * What a run's ⋯ (or a right-click on it) offers, by how it stands: its
 * output, what it serves here, and stopping it; one that failed is dismissed
 * from here. Starting it again is Start's.
 */
export function runActions(run: ProcessRun): MenuAction[] {
  return [
    // First while it is up: the press most often wanted.
    ...(run.state === "running" || run.state === "paused" ? [{ id: "restart", label: "Restart", icon: "reopen" } as MenuAction] : []),
    { id: "output", label: "View output", icon: "terminal" },
    ...(localUrl(run) !== null ? [{ id: "browser", label: "Open in browser", icon: "open" } as MenuAction] : []),
    ...(isLive(run) ? [{ id: "stop", label: "Stop", icon: "stop" } as MenuAction] : [{ id: "dismiss", label: "Dismiss", icon: "close" } as MenuAction]),
  ];
}

/**
 * A run's actions with no pill to hold them, as one group: Start/Stop is the button and there is nothing to dismiss.
 * Its output is worth opening while it runs, and after it failed, to read why; not after a clean stop.
 */
const soloActions = (run: ProcessRun): MenuAction[] =>
  isLive(run) ? runActions(run).filter((entry) => entry.id !== "stop" && entry.id !== "dismiss")
  : failed(run) ? [{ id: "output", label: "View output", icon: "terminal" }]
  : [];

const failed = (run: ProcessRun) => run.state === "crashed" || (run.state === "exited" && run.exitCode !== 0);

/** One run, as one start of it: a pill taken away stays away until it is started again. */
export const runSeen = (processId: string, run: ProcessRun) =>
  `${processId}\u0000${run.worktree ?? ""}\u0000${run.startedAt ?? run.runCursor}`;

/**
 * The runs worth a pill: one up, one just asked for, and one that failed,
 * until its pill is taken away. One stopped or ended cleanly has nothing to say.
 */
export function shownRuns(process: Process, pending: ReadonlySet<string>, dismissed: ReadonlySet<string>): ProcessRun[] {
  return withPending(process, pending).filter((run) => {
    if (pending.has(runKey(process.id, run.worktree))) return true;
    if (dismissed.has(runSeen(process.id, run))) return false;
    return isLive(run) || failed(run);
  });
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

export function specOf(process: Process): ProcessSpec {
  return {
    name: process.name,
    command: process.command,
    cwd: process.cwd,
    env: process.env,
    autoRestart: process.autoRestart,
  };
}

/** Who wrote a command: the user, a session still here, or one since gone. */
export type Origin = { kind: "user" } | { kind: "session"; id: string; session: Session | null };

export function originOf(process: Process, sessions: Session[]): Origin {
  if (process.createdBy === null) return { kind: "user" };
  return { kind: "session", id: process.createdBy, session: sessions.find((session) => session.id === process.createdBy) ?? null };
}

/** A worktree a command can run in: `worktree` null is the main checkout. */
export type Place = { worktree: string | null; label: string };

/** A run asked for and not yet answered, by command and worktree. */
export const runKey = (processId: string, worktree: string | null) => `${processId}\u0000${worktree ?? ""}`;

/**
 * Its runs, with the ones just asked for already starting: the press shows at
 * once, before the daemon's answer, in a row of its own if it never ran there.
 */
export function withPending(process: Process, pending: ReadonlySet<string>): ProcessRun[] {
  const asked = (worktree: string | null) => pending.has(runKey(process.id, worktree));
  const runs = process.runs.map((run) => (asked(run.worktree) && !isLive(run) ? { ...run, state: "starting" as const, restarts: 0, url: null } : run));
  for (const key of pending) {
    const [id, path] = key.split("\u0000") as [string, string];
    const worktree = path === "" ? null : path;
    if (id === process.id && !runs.some((run) => run.worktree === worktree)) runs.push(ghostRun(worktree));
  }
  return runs;
}

function ghostRun(worktree: string | null): ProcessRun {
  return {
    worktree,
    state: "starting",
    pid: null,
    streamId: null,
    startedAt: null,
    exitCode: null,
    restarts: 0,
    ptyId: "",
    logCursor: 0,
    runCursor: 0,
    startedBy: null,
    env: {},
    url: null,
  };
}

/** A worktree git no longer lists still has a name: the end of its path. */
export function placeOf(places: Place[], worktree: string | null): Place {
  return (
    places.find((place) => place.worktree === worktree) ?? {
      worktree,
      label: worktree?.split("/").pop() ?? "main",
    }
  );
}
