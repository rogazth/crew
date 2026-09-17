import * as api from "./api";
import { nextRun, type RoutineDraft } from "./routines";

/**
 * Routines fire in the daemon: a standing order that only runs while a window
 * is open is not a standing order. What is left here is the screen's side of
 * it — saving, deleting, running one on demand, and telling the list to
 * re-read when any of those change something.
 */
const listeners = new Set<() => void>();

/** The routines screen re-reads its list when a run lands. */
export function onRoutinesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The list is stale after a save, a delete or a run. */
function changed(): void {
  for (const listener of listeners) listener();
}

/**
 * "Run now" on the routines screen; the daemon fires it the same way it fires a
 * due one. A refusal — a routine that is gone, a daemon on its way down — is
 * the caller's to show: a button that clears its spinner and says nothing reads
 * as a run that happened.
 */
export async function runRoutineNow(routineId: string): Promise<void> {
  try {
    await api.runRoutineNow(routineId);
  } finally {
    changed();
  }
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
  changed();
  return row.id;
}

export async function removeRoutine(id: string): Promise<void> {
  await api.deleteRoutine(id);
  changed();
}
