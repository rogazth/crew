import { newRoutineDraft, type RoutineDraft } from "./routines";
import type { Session, Workspace } from "./types";

export type RoutineFilter = "all" | "active" | "paused";

/** What the screen has open: a draft not saved yet, or a saved routine by id. */
export type RoutineOpen = { kind: "new"; draft: RoutineDraft; workspaceId: string } | { kind: "edit"; id: string };

type Listed = { routine: { id: string; name: string; enabled: boolean }; session: { name: string; workspaceId: string } };

export function filterRoutines<E extends Listed>(entries: E[] | null, filter: RoutineFilter): E[] {
  return (entries ?? []).filter((entry) =>
    filter === "all" ? true : filter === "active" ? entry.routine.enabled : !entry.routine.enabled,
  );
}

export function emptyLine(hasAny: boolean, hasAgents: boolean, filter: RoutineFilter): string {
  if (hasAny) return `No ${filter} routines.`;
  return hasAgents
    ? "No routines yet. A routine wakes an agent on a schedule with a saved instruction."
    : "Routines run inside an agent's conversation. Create an agent first.";
}

/** A card names its workspace only when that is not the one on screen. */
export function cardWorkspace(entry: Listed, activeWorkspaceId: string | null, workspaces: Workspace[]): string | null {
  const id = entry.session.workspaceId;
  if (id === activeWorkspaceId) return null;
  return workspaces.find((workspace) => workspace.id === id)?.name ?? null;
}

/** A draft handed in (from an agent's drawer) opens straight into the editor. */
export function initialOpen(draft: RoutineDraft | null, activeWorkspaceId: string | null): RoutineOpen | null {
  return draft && activeWorkspaceId ? { kind: "new", draft, workspaceId: activeWorkspaceId } : null;
}

/** A new routine starts on the first agent of the workspace on screen. */
export function newRoutineOpen(agents: Session[], activeWorkspaceId: string | null): RoutineOpen | null {
  const agent = agents[0];
  if (!agent || !activeWorkspaceId) return null;
  return { kind: "new", draft: newRoutineDraft(agent.id), workspaceId: activeWorkspaceId };
}

/** The dialog closes the editor before the routine goes, so nothing edits a deleted row. */
export function deleteConfirm(entry: Listed, close: () => void, remove: (id: string) => Promise<void>) {
  return {
    title: `Delete routine "${entry.routine.name}"?`,
    description: `${entry.session.name} stops running it. Its history goes with it.`,
    action: "Delete",
    onConfirm: async () => {
      close();
      await remove(entry.routine.id);
    },
  };
}
