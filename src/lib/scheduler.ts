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

/** Loads every enabled routine and arms one timer for the earliest. Call once at boot. */
export function startScheduler(): void {
  if (started) return;
  started = true;
  void refreshScheduler();
}

/** Re-read after the sheet saved a routine or a session went away. */
export async function refreshScheduler(): Promise<void> {
  rows = await api.listRoutines().catch(() => []);
  arm();
  for (const listener of listeners) listener();
}

/** The sheet re-reads its list when a run lands. */
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
    if (at === null || at > now) continue;
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

/** "Test run" in the sheet. */
export async function runRoutineNow(routine: Routine, session: Session, cwd: string): Promise<void> {
  await fire(routine, session, cwd, "manual");
}

/** The sheet's list, persisted: drafts are upserted, anything it dropped is deleted. */
export async function saveRoutines(sessionId: string, drafts: RoutineDraft[], removed: string[]): Promise<void> {
  await Promise.all(removed.map((id) => api.deleteRoutine(id).catch(() => {})));
  for (const draft of drafts) {
    const prompt = draft.prompt.trim();
    const name = draft.name.trim() || "Routine";
    if (!prompt) continue;
    const enabled = draft.enabled;
    await api.upsertRoutine({
      ...(draft.id ? { id: draft.id } : {}),
      sessionId,
      name,
      enabled,
      prompt,
      schedule: JSON.stringify(draft.schedule),
      nextRunAt: enabled ? nextRun(draft.schedule, Date.now()) : null,
    });
  }
  await refreshScheduler();
}
