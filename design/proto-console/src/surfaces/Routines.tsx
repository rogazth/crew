import { useState } from "react";
import type { Routine } from "@crew/fixtures";
import { Empty } from "@/ui";
import { store, useApp } from "@/lib/store";
import { RoutineGrid } from "./routines/RoutineGrid";
import { RoutineEditor } from "./routines/RoutineEditor";

/**
 * A new routine is a local draft until Save presses it into the store, so the
 * grid never shows a routine nobody asked to keep.
 */
export function RoutinesPage({ routineId }: { routineId: string | null }) {
  const state = useApp();
  const [draft, setDraft] = useState<Routine | null>(null);

  const create = () => {
    const sessionId =
      state.sessions.find(
        (session) => session.workspaceId === state.workspaceId && session.kind === "agent",
      )?.id ?? "";
    const routine: Routine = {
      id: `r-${Date.now().toString(36)}`,
      sessionId,
      name: "",
      enabled: true,
      prompt: "",
      schedule: { kind: "interval", minutes: 60 },
      lastRunAt: null,
      nextRunAt: null,
      runs: [],
      createdBy: null,
    };
    setDraft(routine);
    store.openRoutines(routine.id);
  };

  if (routineId === null) {
    return <RoutineGrid onNew={create} />;
  }

  const saved = state.routines.find((routine) => routine.id === routineId);
  const routine = saved ?? (draft?.id === routineId ? draft : null);
  if (!routine) {
    return (
      <Empty
        title="That routine is gone."
        hint="It was deleted, or the link outlived it. Go back to the grid to pick another."
      />
    );
  }

  return (
    <RoutineEditor
      key={routine.id}
      routine={routine}
      saved={saved !== undefined}
      onSaved={() => setDraft(null)}
    />
  );
}
