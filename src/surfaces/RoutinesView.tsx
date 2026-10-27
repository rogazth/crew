import { PlusIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { BotAvatar } from "../chrome/BotAvatar";
import { Button, FilterChip, PageFrame, type Option } from "../chrome/kit";
import { RoutineCard, RoutineTable } from "../chrome/RoutineCard";
import { PillTabs } from "../chrome/BotPaneParts";
import { Tabs } from "@base-ui/react/tabs";
import type { Confirm } from "../chrome/ConfirmDialog";
import { useRoutines, type RoutineEntry } from "../hooks/useRoutines";
import { newRoutineDraft, toDraft, type RoutineDraft } from "../lib/routines";
import { nextSort, sortRoutines, type Sort } from "../lib/routineSort";
import { removeRoutine, runRoutineNow, saveRoutine } from "../lib/scheduler";
import type { Session, Workspace } from "../lib/types";
import { RoutineEditor } from "./RoutineEditor";

type Props = {
  /** Set when the page opens straight into a new routine, e.g. from a bot's drawer. */
  draft: RoutineDraft | null;
  /** Set when the page opens straight into one routine's editor, e.g. from a bot's drawer. */
  editId?: string | undefined;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Bots of the active workspace; a new routine starts on the first of them. */
  bots: Session[];
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
export function RoutinesView({ draft, editId, workspaces, activeWorkspaceId, bots, onConfirm }: Props) {
  const entries = useRoutines();
  const [open, setOpen] = useState<Open | null>(() =>
    editId ? { kind: "edit", id: editId } : draft && activeWorkspaceId ? { kind: "new", draft, workspaceId: activeWorkspaceId } : null,
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [botFilter, setBotFilter] = useState("all");
  const [sort, setSort] = useState<Sort>(null);

  const editing = open?.kind === "edit" ? entries?.find((entry) => entry.routine.id === open.id) : null;

  // Workspace, bot and text narrow the list; the tabs then split what is left by state.
  const narrowed = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (entries ?? []).filter(
      ({ routine, session }) =>
        (workspaceFilter === "all" || session.workspaceId === workspaceFilter) &&
        (botFilter === "all" || session.id === botFilter) &&
        (text === "" || [routine.name, routine.prompt, session.name].some((field) => field.toLowerCase().includes(text))),
    );
  }, [entries, query, workspaceFilter, botFilter]);

  const shown = useMemo(
    () =>
      sortRoutines(
        narrowed.filter((entry) => (filter === "all" ? true : filter === "active" ? entry.routine.enabled : !entry.routine.enabled)),
        sort,
      ),
    [narrowed, filter, sort],
  );

  // Only workspaces and bots that have a routine; the bots follow the workspace picked.
  const workspaceOptions = useMemo<Option<string>[]>(() => {
    const ids = new Set((entries ?? []).map((entry) => entry.session.workspaceId));
    return [
      { value: "all", label: "All workspaces" },
      ...workspaces.filter((w) => ids.has(w.id)).map((w) => ({ value: w.id, label: w.name })),
    ];
  }, [entries, workspaces]);

  const botOptions = useMemo<Option<string>[]>(() => {
    const seen = new Map<string, Session>();
    for (const { session } of entries ?? [])
      if (workspaceFilter === "all" || session.workspaceId === workspaceFilter) seen.set(session.id, session);
    return [
      { value: "all", label: "All bots" },
      ...[...seen.values()].map((bot) => ({
        value: bot.id,
        label: bot.name,
        icon: <BotAvatar seed={bot.id} bare className="size-4 shrink-0" />,
      })),
    ];
  }, [entries, workspaceFilter]);

  const startNew = () => {
    const bot = bots[0];
    if (!bot || !activeWorkspaceId) return;
    setOpen({ kind: "new", draft: newRoutineDraft(bot.id), workspaceId: activeWorkspaceId });
  };

  const confirmDelete = (entry: RoutineEntry) =>
    onConfirm({
      title: `Delete routine "${entry.routine.name}"?`,
      description: `${entry.session.name} stops running it. History is deleted.`,
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

  const counts = { all: narrowed.length, active: narrowed.filter((e) => e.routine.enabled).length };
  const narrowing = query.trim() !== "" || workspaceFilter !== "all" || botFilter !== "all";
  return (
    <PageFrame
      title="Routines"
      // The editor's width, so opening a routine does not jump.
      width="reading"
      subtitle="Wake a bot on a schedule with saved instructions."
      actions={
        <Button variant="primary" icon={PlusIcon} disabled={bots.length === 0} onClick={startNew}>
          New routine
        </Button>
      }
    >
      {/* The filters sit close over the list they narrow. */}
      <div className="flex flex-col gap-3">
      {entries !== null && entries.length > 0 && (
        <>
          <label className="flex h-9 min-w-0 items-center gap-2 rounded-[10px] bg-card px-3 transition-shadow focus-within:shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--color-focus)_45%,transparent)]">
            <SearchIcon className="size-4 shrink-0 text-icon" />
            <input
              value={query}
              spellCheck={false}
              placeholder="Search routines"
              aria-label="Search routines"
              onChange={(event) => setQuery(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder"
            />
          </label>
          <div className="flex items-center gap-2">
            <Tabs.Root value={filter} onValueChange={(next) => setFilter(next as Filter)}>
              <PillTabs
                value={filter}
                tabs={FILTERS.map((option) => ({
                  key: option.value,
                  label: (
                    <>
                      {option.label}
                      <span className="tabular-nums opacity-60">
                        {option.value === "all" ? counts.all : option.value === "active" ? counts.active : counts.all - counts.active}
                      </span>
                    </>
                  ),
                }))}
                className="-ml-0.5"
              />
            </Tabs.Root>
            <span className="flex-1" />
            {workspaceOptions.length > 2 && (
              <FilterChip
                label="Workspace"
                value={workspaceFilter}
                neutral="all"
                options={workspaceOptions}
                onChange={(next) => {
                  setWorkspaceFilter(next);
                  setBotFilter("all");
                }}
              />
            )}
            <FilterChip label="Bot" value={botFilter} neutral="all" options={botOptions} onChange={setBotFilter} />
          </div>
        </>
      )}

      {entries !== null && shown.length === 0 ? (
        <Empty hasAny={entries.length > 0} hasBots={bots.length > 0} narrowing={narrowing} filter={filter} />
      ) : (
        shown.length > 0 && (
          <RoutineTable sort={sort} onSort={(key) => setSort((prev) => nextSort(prev, key))}>
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
          </RoutineTable>
        )
      )}
      </div>
    </PageFrame>
  );
}

function Empty({ hasAny, hasBots, narrowing, filter }: { hasAny: boolean; hasBots: boolean; narrowing: boolean; filter: Filter }) {
  const line = narrowing ? "No routines match." : hasAny ? `No ${filter} routines.` : hasBots ? "No routines yet." : "Create a bot to add routines.";
  return <p className="px-4 py-10 text-center text-[13px] text-text-muted">{line}</p>;
}
