import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, PageFrame, type Option } from "../chrome/kit";
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

const FILTERS: Option<Filter>[] = [
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

  const counts = { all: entries?.length ?? 0, active: entries?.filter((e) => e.routine.enabled).length ?? 0 };
  return (
    <PageFrame
      title="Routines"
      subtitle="Standing orders: an agent wakes on a schedule with a saved instruction."
      actions={
        <Button variant="primary" icon={PlusIcon} disabled={agents.length === 0} onClick={startNew}>
          New routine
        </Button>
      }
    >
      {entries !== null && entries.length > 0 && (
        <div className="flex items-center gap-1 border-b border-hairline pb-3">
          {FILTERS.map((option) => {
            const on = option.value === filter;
            const count =
              option.value === "all" ? counts.all : option.value === "active" ? counts.active : counts.all - counts.active;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(option.value)}
                className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors ${
                  on ? "bg-accent text-inverse" : "text-text-muted hover:bg-hover hover:text-text"
                }`}
              >
                {option.label}
                <span className="tabular-nums opacity-60">{count}</span>
              </button>
            );
          })}
          <span className="ml-auto flex items-center gap-3 text-[11px] text-text-muted">
            <span className="w-40">Schedule</span>
            <span className="w-16 text-right">Last runs</span>
            <span className="w-20 text-right">Next</span>
          </span>
        </div>
      )}

      {entries !== null && shown.length === 0 ? (
        <Empty hasAny={entries.length > 0} hasAgents={agents.length > 0} filter={filter} />
      ) : (
        <div className="-mx-3 flex flex-col gap-0.5">
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
    </PageFrame>
  );
}

function Empty({ hasAny, hasAgents, filter }: { hasAny: boolean; hasAgents: boolean; filter: Filter }) {
  const line = hasAny
    ? `No ${filter} routines.`
    : hasAgents
      ? "No routines yet. A routine wakes an agent on a schedule with a saved instruction."
      : "Routines run inside an agent's conversation. Create an agent first.";
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-text-muted">
      {line}
    </p>
  );
}
