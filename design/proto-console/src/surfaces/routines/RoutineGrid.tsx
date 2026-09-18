import clsx from "clsx";
import { useRef, useState } from "react";
import { X } from "lucide-react";
import { nextRun, summarizePrompt, type Routine } from "@crew/fixtures";
import { Badge, Button, Empty, IconButton, Menu, ProviderMark, Segmented } from "@/ui";
import { store, useApp } from "@/lib/store";
import { scheduleLabel } from "@/lib/cron";

type Filter = "all" | "active" | "paused";

const EMPTY_HINT: Record<Filter, { title: string; hint: string }> = {
  all: {
    title: "No routines yet.",
    hint: "A routine is a standing order: an agent, a prompt and a schedule. Create one and it runs without you.",
  },
  active: {
    title: "Every routine is paused.",
    hint: "Open one and turn Enabled back on, or switch the filter to see them all.",
  },
  paused: {
    title: "Nothing is paused.",
    hint: "Every routine you have is running on its schedule.",
  },
};

export function RoutineGrid({ onNew }: { onNew: () => void }) {
  const state = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const shown = state.routines.filter((routine) =>
    filter === "all" ? true : filter === "active" ? routine.enabled : !routine.enabled,
  );
  const paused = state.routines.filter((routine) => !routine.enabled).length;

  const count = (n: number) => <span className="pl-1 font-mono text-xs opacity-60">{n}</span>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
        <span className="font-mono text-xs tracking-wide text-ink-3 uppercase">routines</span>
        <span className="font-mono text-xs text-ink-4">{state.routines.length}</span>
        <IconButton label="Close routines" className="ml-auto" onClick={() => store.closePage()}>
          <X size={13} strokeWidth={1.25} />
        </IconButton>
      </header>

      <div className="scroll min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-6 pt-8 pb-16">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-xl">Routines</h1>
              <p className="max-w-[60ch] text-sm text-ink-3">
                A standing order for an agent: a prompt it runs on a schedule, whether or not
                anyone is watching.
              </p>
            </div>
            <Button variant="primary" onClick={onNew}>
              New routine
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <Segmented<Filter>
              label="Filter routines"
              value={filter}
              onChange={setFilter}
              options={[
                { id: "all", label: <>All{count(state.routines.length)}</> },
                { id: "active", label: <>Active{count(state.routines.length - paused)}</> },
                { id: "paused", label: <>Paused{count(paused)}</> },
              ]}
            />
          </div>

          {shown.length === 0 ? (
            <div className="py-16">
              <Empty title={EMPTY_HINT[filter].title} hint={EMPTY_HINT[filter].hint} />
            </div>
          ) : (
            <div className="@container">
              <div className="grid grid-cols-1 gap-3 @min-[900px]:grid-cols-2">
                {shown.map((routine) => (
                  <RoutineCard key={routine.id} routine={routine} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RoutineCard({ routine }: { routine: Routine }) {
  const state = useApp();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const agent = state.sessions.find((session) => session.id === routine.sessionId);
  const failed = routine.runs[0]?.status === "error";
  const summary = summarizePrompt(routine.prompt);

  const duplicate = () => {
    const copy: Routine = {
      ...routine,
      id: `r-${Date.now().toString(36)}`,
      name: `${routine.name} copy`,
      runs: [],
      lastRunAt: null,
      nextRunAt: routine.enabled ? nextRun(routine.schedule) : null,
    };
    store.saveRoutine(copy);
    store.notify(`Duplicated ${routine.name}`);
  };

  const remove = () =>
    store.confirm({
      title: `Delete ${routine.name}?`,
      description: "The routine and its run history go with it. This cannot be undone.",
      action: "Delete",
      destructive: true,
      onConfirm: () => {
        store.deleteRoutine(routine.id);
        store.notify(`Deleted ${routine.name}`);
      },
    });

  return (
    <div
      className={clsx(
        "group relative flex flex-col gap-2 rounded-[var(--r)] border border-rule bg-raised px-3 py-3",
        "transition-colors duration-[var(--fast)] hover:border-rule-strong focus-within:border-accent",
        !routine.enabled && "bg-bg",
      )}
    >
      <button
        type="button"
        aria-label={`Open ${routine.name}`}
        onClick={() => store.openRoutines(routine.id)}
        className="absolute inset-0 rounded-[var(--r)]"
      />

      <div className="pointer-events-none relative flex items-center gap-2">
        {agent ? <ProviderMark provider={agent.provider} /> : null}
        <span className="truncate font-mono text-xs text-ink-3">{agent?.name ?? "no agent"}</span>
        {routine.enabled ? null : <Badge>paused</Badge>}
        <span ref={anchor} className="pointer-events-auto -my-1 ml-auto inline-flex">
          <IconButton
            label={`Actions for ${routine.name}`}
            onClick={() => setOpen(true)}
            className={clsx(
              "font-mono text-md text-ink-3",
              open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            ⋯
          </IconButton>
        </span>
      </div>

      <div className="pointer-events-none relative flex flex-col gap-1">
        <h2 className="truncate text-md font-semibold text-ink">{routine.name}</h2>
        <p className="line-clamp-2 min-h-[calc(var(--lh-sm)*2)] text-sm text-ink-2">
          {summary || "No instructions yet."}
        </p>
      </div>

      <div className="pointer-events-none relative flex items-center gap-2 border-t border-rule pt-2 font-mono text-xs">
        <span className="truncate text-ink-3">{scheduleLabel(routine.schedule)}</span>
        <span className="shrink-0 text-ink-4" aria-hidden>
          →
        </span>
        <span className="truncate text-ink-3">{agent?.name ?? "unassigned"}</span>
        {failed ? (
          <span className="ml-auto shrink-0 text-red-ink">✕ last run failed</span>
        ) : null}
      </div>

      <Menu
        open={open}
        anchor={anchor.current}
        onClose={() => setOpen(false)}
        align="end"
        label={`Actions for ${routine.name}`}
        items={[
          {
            id: "run",
            label: "Run now",
            onSelect: () => {
              store.runRoutine(routine.id);
              store.notify(`Running ${routine.name}`);
            },
          },
          { id: "duplicate", label: "Duplicate", onSelect: duplicate },
          { kind: "separator", id: "sep" },
          { id: "delete", label: "Delete", destructive: true, onSelect: remove },
        ]}
      />
    </div>
  );
}
