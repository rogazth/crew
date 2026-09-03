import { send } from "./agentRuntime";
import * as api from "./api";
import * as transcript from "./transcript";
import { nextRun, parseSchedule, type RoutineDraft, type ScheduledRoutine } from "./routines";

/** Timers drift across sleep; a short cap keeps a due run from waiting until tomorrow. */
const MAX_WAIT_MS = 60_000;

let timer: number | null = null;
let rows: ScheduledRoutine[] = [];
let started = false;

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
    await fire(row, now);
  }
  arm();
}

/** A routine opens a fresh episode: yesterday's digest is not context for today's. */
async function fire(row: ScheduledRoutine, now: number): Promise<void> {
  const schedule = parseSchedule(row.routine.schedule);
  const next = nextRun(schedule, now);
  row.routine.lastRunAt = now;
  row.routine.nextRunAt = next;
  void api.markRoutineRun(row.routine.id, now, next).catch(() => {});
  if (transcript.read(row.session.id).working) return;
  transcript.apply(row.session.id, { type: "session.note", message: "Scheduled run" });
  void send(row.session, row.cwd, row.routine.prompt, [], { fresh: true });
}

/** The sheet's schedule card, persisted. An empty, disabled card means no routine at all. */
export async function saveRoutine(sessionId: string, draft: RoutineDraft): Promise<void> {
  const prompt = draft.prompt.trim();
  if (!draft.enabled && !prompt) {
    await api.deleteRoutine(sessionId).catch(() => {});
  } else {
    const enabled = draft.enabled && prompt.length > 0;
    await api.upsertRoutine({
      sessionId,
      enabled,
      prompt,
      schedule: JSON.stringify(draft.schedule),
      nextRunAt: enabled ? nextRun(draft.schedule, Date.now()) : null,
    });
  }
  await refreshScheduler();
}
