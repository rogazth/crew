import { CircleAlertIcon, ClockIcon } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import type { RoutineEntry } from "../hooks/useRoutines";
import { describeSchedule, parseSchedule, summarize, type RunStatus } from "../lib/routines";
import { until } from "../lib/time";

type Props = {
  entry: RoutineEntry;
  /** Only set when the routine lives outside the workspace on screen. */
  workspace: string | null;
  onOpen: () => void;
};

const RUN_TONE: Record<RunStatus, string> = {
  ok: "bg-success",
  error: "bg-danger",
  skipped: "bg-border-strong",
  running: "bg-warning animate-status-pulse",
};

const RUN_LABEL: Record<RunStatus, string> = { ok: "Ran", error: "Failed", skipped: "Skipped", running: "Running" };

/**
 * One routine as a row, Linear's list rather than a grid of cards: who runs it
 * and what it says on the left; when it fires, how the last runs went and when
 * the next one is on the right, in columns that line up down the page.
 */
export function RoutineCard({ entry, workspace, onOpen }: Props) {
  const { routine, session } = entry;
  const description = summarize(routine.prompt);
  const failed = routine.runs[0]?.status === "error";
  const recent = routine.runs.slice(0, 6).reverse();

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover ${
        routine.enabled ? "" : "opacity-60 hover:opacity-100"
      }`}
    >
      <AgentAvatar seed={session.id} bare className="size-7" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{routine.name || "Untitled routine"}</span>
          {routine.enabled && failed && (
            <CircleAlertIcon className="size-3.5 shrink-0 text-danger" aria-label="Last run failed" />
          )}
        </span>
        <span className="truncate text-[12px] text-text-muted">
          {session.name}
          {workspace && <span className="text-placeholder"> · {workspace}</span>}
          {description && <span className="text-placeholder"> — {description}</span>}
        </span>
      </span>

      <span className="flex w-40 shrink-0 items-center gap-1.5 text-[12px] text-text-muted">
        <ClockIcon className="size-3.5 shrink-0 text-icon" />
        <span className="truncate">{describeSchedule(parseSchedule(routine.schedule))}</span>
      </span>

      <span className="flex w-16 shrink-0 items-center justify-end gap-1" aria-label="Recent runs">
        {recent.map((run) => (
          <span
            key={run.id}
            title={`${RUN_LABEL[run.status]} · ${new Date(run.startedAt).toLocaleString()}`}
            className={`h-3.5 w-1.5 rounded-full ${RUN_TONE[run.status]}`}
          />
        ))}
      </span>

      <span className="w-20 shrink-0 text-right text-[12px] tabular-nums">
        {routine.enabled ? (
          <span className="text-text">{routine.nextRunAt ? until(routine.nextRunAt) : "—"}</span>
        ) : (
          <span className="rounded-full px-2 py-0.5 text-text-muted ring-1 ring-hairline">Paused</span>
        )}
      </span>
    </button>
  );
}
