import { ArrowDownIcon, ArrowUpIcon, CheckIcon, LoaderCircleIcon, MinusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { BotAvatar } from "./BotAvatar";
import type { RoutineEntry } from "../hooks/useRoutines";
import { describeSchedule, parseSchedule, type RoutineRun } from "../lib/routines";
import type { Sort, SortKey } from "../lib/routineSort";
import { ago, until } from "../lib/time";

type Props = {
  entry: RoutineEntry;
  /** Only set when the routine lives outside the workspace on screen. */
  workspace: string | null;
  onOpen: () => void;
};

// One set of columns for the head and every row, so they line up as a table.
// Narrow, the schedule column goes; the routine's page still says it.
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_88px_84px] items-center gap-3 @[600px]:grid-cols-[minmax(0,1fr)_148px_88px_84px]";

/**
 * The routines as a table drawn on the sheet itself, Linear-style: no card
 * under it, a hairline under the head and under each row, and the row under
 * the pointer lit. Each head sorts by its column.
 */
export function RoutineTable({ sort, onSort, children }: { sort: Sort; onSort: (key: SortKey) => void; children: ReactNode }) {
  const head = (key: SortKey, label: string, className = "") => (
    <Head key={key} label={label} dir={sort?.key === key ? sort.dir : null} onClick={() => onSort(key)} className={className} />
  );
  return (
    <div role="table" aria-label="Routines" className="flex flex-col">
      <div role="row" className={`${COLUMNS} h-8 border-b border-hairline px-2 text-[12px] font-medium text-text-muted`}>
        {head("name", "Routine")}
        {head("schedule", "Schedule", "hidden @[600px]:flex")}
        {head("last", "Last run")}
        {/* Right-aligned, its arrow goes before the label, so the label ends where the times do. */}
        {head("next", "Next run", "justify-end [&_button]:flex-row-reverse")}
      </div>
      {children}
    </div>
  );
}

function Head({ label, dir, onClick, className = "" }: { label: string; dir: "asc" | "desc" | null; onClick: () => void; className?: string }) {
  const Arrow = dir === "desc" ? ArrowDownIcon : ArrowUpIcon;
  return (
    <span role="columnheader" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"} className={`flex min-w-0 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        className={`group -mx-1 flex h-6 min-w-0 items-center gap-1 rounded-md px-1 outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 ${dir ? "text-text" : ""}`}
      >
        <span className="truncate">{label}</span>
        {/* Room for the arrow is always kept, so a sort shifts nothing; it shows faintly on hover. */}
        <Arrow className={`size-3 shrink-0 transition-opacity ${dir ? "opacity-100" : "opacity-0 group-hover:opacity-50"}`} />
      </button>
    </span>
  );
}

/**
 * One routine as a row of the routines' table: its name over the bot that
 * runs it, when it runs, how its last run went, and when it runs next. A press anywhere on it opens it.
 */
export function RoutineCard({ entry, workspace, onOpen }: Props) {
  const { routine, session } = entry;
  const last = routine.runs[0];
  const schedule = parseSchedule(routine.schedule);
  const when = describeSchedule(schedule);
  const bot = workspace ? `${session.name} · ${workspace}` : session.name;
  // A once routine runs on schedule a single time, and the daemon then
  // switches it off: done, not paused.
  const done = !routine.enabled && schedule.kind === "once" && routine.runs.some((run) => run.trigger === "schedule");

  return (
    <button
      type="button"
      role="row"
      onClick={onOpen}
      className={`${COLUMNS} h-13 w-full border-b border-hairline px-2 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover ${
        routine.enabled ? "" : "[&>*]:opacity-60"
      }`}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13px] leading-[18px] font-medium">{routine.name || "Untitled routine"}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-text-muted" title={bot}>
          <BotAvatar seed={session.id} bare className="size-3.5 shrink-0" />
          <span className="truncate">{bot}</span>
        </span>
      </span>

      <span className="hidden truncate text-[12px] text-text-muted @[600px]:block">{when}</span>

      <span className="flex min-w-0 items-center gap-1.5 text-[12px] tabular-nums text-text-muted">
        {last ? (
          <>
            <RunMark run={last} />
            <span className="truncate" title={new Date(last.startedAt).toLocaleString()}>
              {last.status === "running" ? "Running" : ago(last.startedAt)}
            </span>
          </>
        ) : (
          <span className="text-placeholder">Never</span>
        )}
      </span>

      <span
        className="truncate text-right text-[12px] tabular-nums text-text-muted"
        title={routine.enabled && routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString() : undefined}
      >
        {routine.enabled ? (routine.nextRunAt ? until(routine.nextRunAt) : "—") : done ? "Done" : "Paused"}
      </span>
    </button>
  );
}

/** How one run went, as a mark: ran, failed, skipped, or still running. */
export function RunMark({ run }: { run: RoutineRun }) {
  if (run.status === "running")
    return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-warning" />;
  if (run.status === "ok") return <CheckIcon className="size-3.5 shrink-0 text-success" />;
  // Came due while the bot was busy: nothing ran, and nothing went wrong.
  if (run.status === "skipped") return <MinusIcon className="size-3.5 shrink-0 text-placeholder" />;
  return <XIcon className="size-3.5 shrink-0 text-danger" aria-label="Failed" />;
}
