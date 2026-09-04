import { send } from "./agentRuntime";
import * as api from "./api";
import { newBlock } from "./blocks";
import {
  fromRow,
  nextRun,
  parseSchedule,
  pushRun,
  wakePrompt,
  type Routine,
  type RoutineDraft,
  type RoutineRun,
  type ScheduledRoutine,
} from "./routines";
import * as transcript from "./transcript";
import type { Session } from "./types";

/** Timers drift across sleep; a short cap keeps a due run from waiting until tomorrow. */
const MAX_WAIT_MS = 60_000;

let timer: number | null = null;
let rows: ScheduledRoutine[] = [];
let started = false;
const listeners = new Set<() => void>();

/** Loads every routine and arms one timer for the earliest due. Call once at boot. */
export function startScheduler(): void {
  if (started) return;
  started = true;
  void refreshScheduler();
}

/** Re-read after a routine was saved or a session went away. */
export async function refreshScheduler(): Promise<void> {
  rows = await api.listRoutines().catch(() => []);
  arm();
  for (const listener of listeners) listener();
}

/** The routines screen re-reads its list when a run lands. */
export function onRoutinesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function arm(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  const due = rows
    .map((row) => row.routine.nextRunAt ?? Number.POSITIVE_INFINITY)
    .reduce((min, at) => Math.min(min, at), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(due)) return;
  const wait = Math.max(0, Math.min(due - Date.now(), MAX_WAIT_MS));
  timer = window.setTimeout(tick, wait);
}

async function tick(): Promise<void> {
  timer = null;
  const now = Date.now();
  for (const row of rows) {
    const at = row.routine.nextRunAt;
    if (!row.routine.enabled || at === null || at > now) continue;
    void fire(fromRow(row.routine), row.session, row.cwd, "schedule");
    row.routine.nextRunAt = nextRun(parseSchedule(row.routine.schedule), now);
  }
  arm();
}

/**
 * A routine joins the agent's conversation as a hidden turn: what it found
 * last time is context for this time. The note is the only trace of the wake-up.
 */
async function fire(routine: Routine, session: Session, cwd: string, trigger: RoutineRun["trigger"]): Promise<void> {
  const now = Date.now();
  const schedule = parseSchedule(routine.schedule);
  const next = routine.enabled ? nextRun(schedule, now) : null;
  const run: RoutineRun = { id: crypto.randomUUID(), startedAt: now, finishedAt: null, status: "running", trigger };
  let runs = pushRun(routine.runs, run);
  await api.markRoutineRun(routine.id, now, next, JSON.stringify(runs)).catch(() => {});
  await refreshScheduler();

  let ok = false;
  await transcript.load(session.id);
  if (!transcript.read(session.id).working) {
    transcript.append(session.id, newBlock("system", `Routine · ${routine.name}`));
    const by = await creatorName(routine, session);
    ok = await send(session, cwd, wakePrompt(routine.name, schedule, trigger, routine.prompt, by), [], { hidden: true });
  }
  runs = pushRun(runs, { ...run, finishedAt: Date.now(), status: ok ? "ok" : "error" });
  await api.markRoutineRun(routine.id, now, next, JSON.stringify(runs)).catch(() => {});
  await refreshScheduler();
}

/** Null when the user or the agent itself wrote the routine. */
async function creatorName(routine: Routine, session: Session): Promise<string | null> {
  if (!routine.createdBy || routine.createdBy === session.id) return null;
  const creator = await api.getSession(routine.createdBy).catch(() => null);
  return creator?.name ?? "another agent";
}

/** "Run now" on the routines screen. */
export async function runRoutineNow(routine: Routine, session: Session, cwd: string): Promise<void> {
  await fire(routine, session, cwd, "manual");
}

/** One routine, persisted. Returns the id so a new draft can keep editing itself. */
export async function saveRoutine(draft: RoutineDraft): Promise<string> {
  const schedule = draft.schedule;
  const row = await api.upsertRoutine({
    ...(draft.id ? { id: draft.id } : {}),
    sessionId: draft.sessionId,
    name: draft.name.trim() || "Routine",
    enabled: draft.enabled,
    prompt: draft.prompt.trim(),
    schedule: JSON.stringify(schedule),
    nextRunAt: draft.enabled ? nextRun(schedule, Date.now()) : null,
  });
  await refreshScheduler();
  return row.id;
}

export async function removeRoutine(id: string): Promise<void> {
  await api.deleteRoutine(id);
  await refreshScheduler();
}
