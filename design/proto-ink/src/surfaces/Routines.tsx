import { useState } from "react";
import type { Routine, Schedule, Session } from "@crew/fixtures";
import { clockLabel, dayName } from "@/lib/cron";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { useApp } from "@/lib/store";
import {
  Avatar,
  Badge,
  Button,
  ContextMenu,
  Empty,
  MenuItem,
  MenuSeparator,
  Pulse,
  ScrollArea,
  Segmented,
} from "@/ui";
import { RoutineEditor } from "./RoutineEditor";

type Filter = "all" | "active" | "paused";

const WEEKDAYS = [1, 2, 3, 4, 5];

function scheduleLabel(schedule: Schedule): string {
  if (schedule.kind === "interval") {
    const { minutes } = schedule;
    if (minutes === 60) return "Every hour";
    if (minutes > 60 && minutes % 60 === 0) return `Every ${minutes / 60} hours`;
    return `Every ${minutes} minutes`;
  }
  if (schedule.kind === "daily") {
    const at = clockLabel(schedule.hour, schedule.minute);
    const { days } = schedule;
    if (days.length === 0 || days.length === 7) return `Every day at ${at}`;
    if (days.length === WEEKDAYS.length && WEEKDAYS.every((d) => days.includes(d))) {
      return `Weekdays at ${at}`;
    }
    return `${days.map(dayName).join(", ")} at ${at}`;
  }
  return `Cron · ${schedule.expression}`;
}

/** The label, but with the expression set in mono — a cron line *is* code. */
function ScheduleText({ schedule }: { schedule: Schedule }) {
  if (schedule.kind !== "cron") return <>{scheduleLabel(schedule)}</>;
  return (
    <>
      Cron ·{" "}
      <span className="font-mono text-micro tracking-normal">{schedule.expression}</span>
    </>
  );
}

function RoutineCard({ routine, session }: { routine: Routine; session: Session | undefined }) {
  const { actions } = useApp();
  const newest = routine.runs.reduce<Routine["runs"][number] | null>(
    (held, run) => (held === null || run.startedAt > held.startedAt ? run : held),
    null,
  );
  const agentName = session?.name ?? "unassigned";

  return (
    <ContextMenu
      trigger={
        <button
          type="button"
          onClick={() => actions.openRoutines(routine.id)}
          className={cx(
            "group relative flex h-full flex-col gap-1.5 overflow-hidden rounded-card p-3.5 text-left",
            "bg-chrome hairline",
          )}
        >
          {/* Hover raises the fill, never the shadow: a card is level 0 and stays there. */}
          <span
            aria-hidden
            className={cx(
              "pointer-events-none absolute inset-0 bg-[var(--fill-quaternary)]",
              "opacity-0 transition-opacity duration-[var(--dur-2)] group-hover:opacity-100",
            )}
          />

          <span className="relative flex items-center gap-2">
            <Avatar seed={agentName} size={18} kind={session?.kind ?? "agent"} />
            <span className="min-w-0 truncate text-small text-tertiary">{agentName}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {newest?.status === "running" && <Pulse label={`${routine.name} is running`} />}
              {!routine.enabled && <Badge>Paused</Badge>}
            </span>
          </span>

          <span className="relative truncate text-body font-[var(--weight-medium)] text-primary">
            {routine.name}
          </span>

          <span className="relative line-clamp-2 text-small text-tertiary">
            {routine.prompt || "No instructions yet."}
          </span>

          <span className="relative mt-auto flex items-center gap-1.5 pt-2 text-small text-tertiary">
            <Icon name="calendar" size={14} className="shrink-0 text-icon-faint" />
            <span className="min-w-0 truncate">
              <ScheduleText schedule={routine.schedule} /> · {agentName}
            </span>
          </span>

          {newest?.status === "error" && (
            <span className="relative flex items-center gap-1.5 text-small text-[var(--status-danger)]">
              <Icon name="warning" size={14} className="shrink-0" />
              Last run failed
            </span>
          )}
        </button>
      }
    >
      <MenuItem icon="play" onClick={() => actions.runRoutine(routine.id)}>
        Run now
      </MenuItem>
      <MenuItem
        icon={routine.enabled ? "pause" : "play"}
        onClick={() => actions.updateRoutine(routine.id, { enabled: !routine.enabled })}
      >
        {routine.enabled ? "Pause" : "Resume"}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        destructive
        icon="trash"
        onClick={() =>
          actions.confirm({
            title: `Delete ${routine.name}?`,
            description: "The routine and its run history go with it. This cannot be undone.",
            confirmLabel: "Delete routine",
            destructive: true,
            onConfirm: () => actions.deleteRoutine(routine.id),
          })
        }
      >
        Delete
      </MenuItem>
    </ContextMenu>
  );
}

function RoutineGrid() {
  const { routines, sessions, activeWorkspaceId, actions } = useApp();
  const [filter, setFilter] = useState<Filter>("all");

  const active = routines.filter((r) => r.enabled).length;
  const shown = routines.filter((r) =>
    filter === "all" ? true : filter === "active" ? r.enabled : !r.enabled,
  );

  const firstAgent = sessions.find((s) => s.kind === "agent" && s.workspaceId === activeWorkspaceId);
  const create = () => {
    if (firstAgent) actions.createRoutine(firstAgent.id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--stroke-tertiary)] px-3">
        <h1 className="text-body font-[var(--weight-medium)] text-primary">Routines</h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Segmented<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: routines.length },
              { value: "active", label: "Active", count: active },
              { value: "paused", label: "Paused", count: routines.length - active },
            ]}
          />
          <Button tone="primary" icon="plus" onClick={create} disabled={!firstAgent}>
            New routine
          </Button>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-4xl px-6 py-10">
          {shown.length === 0 ? (
            <Empty
              icon="routine"
              title={
                filter === "paused"
                  ? "Nothing is paused"
                  : filter === "active"
                    ? "Nothing is running on a schedule"
                    : "No routines yet"
              }
              description="A routine is a standing order: an agent, a prompt, and a schedule it keeps without you."
              action={
                filter === "all" ? (
                  <Button tone="primary" icon="plus" onClick={create} disabled={!firstAgent}>
                    New routine
                  </Button>
                ) : (
                  <Button onClick={() => setFilter("all")}>Show all routines</Button>
                )
              }
            />
          ) : (
            <div className="grid grid-cols-1 items-stretch gap-3 min-[900px]:grid-cols-2">
              {shown.map((routine) => (
                <RoutineCard
                  key={routine.id}
                  routine={routine}
                  session={sessions.find((s) => s.id === routine.sessionId)}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function Routines() {
  const { page, routines } = useApp();
  const routineId = page?.kind === "routines" ? page.routineId : null;
  const routine = routineId ? routines.find((r) => r.id === routineId) : undefined;
  return routine ? <RoutineEditor routine={routine} /> : <RoutineGrid />;
}
