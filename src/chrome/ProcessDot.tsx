import { LoaderCircleIcon } from "lucide-react";
import { stateLabel, stateTone, type ProcessRun } from "../lib/processes";

const FILL = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  // Down by choice: an outline, so it reads as present but idle.
  quiet: "ring-1 ring-inset ring-text-muted/60",
} as const;

/** Where a run stands, at a glance; none is a command that is stopped. The label is there for a pointer or a reader. */
export function ProcessDot({ run, className = "" }: { run: ProcessRun | undefined; className?: string }) {
  const label = stateLabel(run);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`flex size-3.5 shrink-0 items-center justify-center ${className}`}
    >
      {run?.state === "starting" ? (
        <LoaderCircleIcon className="size-3.5 animate-spin text-warning" strokeWidth={2.5} />
      ) : (
        <span className={`size-2 rounded-full ${FILL[stateTone(run)]}`} />
      )}
    </span>
  );
}
