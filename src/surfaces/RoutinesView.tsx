import { Button, Tabs } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { RoutineCard } from "../chrome/RoutineCard";
import type { Confirm } from "../chrome/ConfirmDialog";
import { useRoutines, type RoutineEntry } from "../hooks/useRoutines";
import { newRoutineDraft, toDraft, type RoutineDraft } from "../lib/routines";
import { removeRoutine, runRoutineNow, saveRoutine } from "../lib/scheduler";
import type { Session, Workspace } from "../lib/types";
import { RoutineEditor } from "./RoutineEditor";

type Props = {
  /** Set when the page opens straight into a new routine, e.g. from an agent's drawer. */
  draft: RoutineDraft | null;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Agents of the active workspace; a new routine starts on the first of them. */
  agents: Session[];
  onConfirm: (confirm: Confirm) => void;
};

type Filter = "all" | "active" | "paused";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

type Open = { kind: "new"; draft: RoutineDraft; workspaceId: string } | { kind: "edit"; id: string };

/** The routines screen: every standing order in the app, and one editor for them. */
export function RoutinesView({ draft, workspaces, activeWorkspaceId, agents, onConfirm }: Props) {
  const entries = useRoutines();
  const [open, setOpen] = useState<Open | null>(() =>
    draft && activeWorkspaceId ? { kind: "new", draft, workspaceId: activeWorkspaceId } : null,
  );
  const [filter, setFilter] = useState<Filter>("all");

  const editing = open?.kind === "edit" ? entries?.find((entry) => entry.routine.id === open.id) : null;

  const shown = useMemo(
    () =>
      (entries ?? []).filter((entry) =>
        filter === "all" ? true : filter === "active" ? entry.routine.enabled : !entry.routine.enabled,
      ),
    [entries, filter],
  );

  const startNew = () => {
    const agent = agents[0];
    if (!agent || !activeWorkspaceId) return;
    setOpen({ kind: "new", draft: newRoutineDraft(agent.id), workspaceId: activeWorkspaceId });
  };

  const confirmDelete = (entry: RoutineEntry) =>
    onConfirm({
      title: `Delete routine "${entry.routine.name}"?`,
      description: `${entry.session.name} stops running it. Its history goes with it.`,
      action: "Delete",
      onConfirm: async () => {
        setOpen(null);
        await removeRoutine(entry.routine.id);
      },
    });

  if (open?.kind === "new") {
    return (
      <RoutineEditor
        key={open.draft.key}
        initial={open.draft}
        initialWorkspaceId={open.workspaceId}
        workspaces={workspaces}
        runs={[]}
        onSave={async (draft) => {
          const id = await saveRoutine(draft);
          setOpen({ kind: "edit", id });
        }}
        onDelete={null}
        onRunNow={null}
        onBack={() => setOpen(null)}
      />
    );
  }

  if (editing) {
    return (
      <RoutineEditor
        key={editing.routine.id}
        initial={toDraft(editing.routine)}
        initialWorkspaceId={editing.session.workspaceId}
        workspaces={workspaces}
        runs={editing.routine.runs}
        onSave={async (draft) => {
          await saveRoutine(draft);
        }}
        onDelete={() => confirmDelete(editing)}
        onRunNow={() => runRoutineNow(editing.routine.id)}
        onBack={() => setOpen(null)}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-10 py-12">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-[20px] leading-tight font-semibold tracking-[-0.26px]">Routines</h1>
          <Button
            variant="primary"
            size="sm"
            icon={PlusIcon}
            disabled={agents.length === 0}
            onClick={startNew}
          >
            New routine
          </Button>
        </div>

        {entries !== null && entries.length > 0 && (
          <Tabs
            variant="segmented"
            size="sm"
            className="self-start"
            tabs={FILTERS}
            value={filter}
            onValueChange={(value) => setFilter(value as Filter)}
          />
        )}

        {entries !== null && shown.length === 0 ? (
          <Empty hasAny={entries.length > 0} hasAgents={agents.length > 0} filter={filter} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {shown.map((entry) => (
              <RoutineCard
                key={entry.routine.id}
                entry={entry}
                workspace={
                  entry.session.workspaceId === activeWorkspaceId
                    ? null
                    : (workspaces.find((w) => w.id === entry.session.workspaceId)?.name ?? null)
                }
                onOpen={() => setOpen({ kind: "edit", id: entry.routine.id })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ hasAny, hasAgents, filter }: { hasAny: boolean; hasAgents: boolean; filter: Filter }) {
  const line = hasAny
    ? `No ${filter} routines.`
    : hasAgents
      ? "No routines yet. A routine wakes an agent on a schedule with a saved instruction."
      : "Routines run inside an agent's conversation. Create an agent first.";
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-kumo-subtle">
      {line}
    </p>
  );
}
