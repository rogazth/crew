import { ClockIcon, PauseCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { AgentAvatar } from "./AgentAvatar";
import type { RoutineEntry } from "../hooks/useRoutines";
import { describeSchedule, parseSchedule, summarize } from "../lib/routines";

type Props = {
  entry: RoutineEntry;
  /** Only set when the routine lives outside the workspace on screen. */
  workspace: string | null;
  onOpen: () => void;
};

/** One routine in the grid: who runs it, what it says, and when it fires. */
export function RoutineCard({ entry, workspace, onOpen }: Props) {
  const { routine, session } = entry;
  const description = summarize(routine.prompt);
  const failed = routine.runs[0]?.status === "error";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 rounded-xl bg-card p-4 text-left ring-1 ring-hairline outline-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:ring-kumo-focus/50"
    >
      <AgentAvatar seed={session.id} bare className="size-8" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{routine.name || "Untitled routine"}</span>
          {!routine.enabled && (
            <span className="flex shrink-0 items-center gap-1 text-[12px] text-kumo-subtle">
              <PauseCircleIcon className="size-3.5" />
              Paused
            </span>
          )}
          {routine.enabled && failed && (
            <WarningCircleIcon className="size-4 shrink-0 text-danger" aria-label="Last run failed" />
          )}
        </span>
        {description && (
          <span className="line-clamp-2 text-kumo-subtle">{description}</span>
        )}
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-kumo-subtle">
          <ClockIcon className="size-3.5 shrink-0" />
          <span className="shrink-0">{describeSchedule(parseSchedule(routine.schedule))}</span>
          <span aria-hidden className="shrink-0 text-placeholder">
            →
          </span>
          <span className="truncate">
            {session.name}
            {workspace && <span className="text-placeholder"> · {workspace}</span>}
          </span>
        </span>
      </span>
    </button>
  );
}
