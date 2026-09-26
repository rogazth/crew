import { CircleNotchIcon } from "@phosphor-icons/react";
import { stateLabel, stateTone, type Process } from "../lib/processes";

const FILL = {
  success: "bg-kumo-success",
  warning: "bg-kumo-warning",
  danger: "bg-kumo-danger",
  // Down by choice: an outline, so it reads as present but idle.
  quiet: "ring-1 ring-inset ring-kumo-subtle/60",
} as const;

/** Where a process stands, at a glance; the label is there for a pointer or a reader. */
export function ProcessDot({ process, className = "" }: { process: Process; className?: string }) {
  const label = stateLabel(process);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`flex size-3.5 shrink-0 items-center justify-center ${className}`}
    >
      {process.state === "starting" ? (
        <CircleNotchIcon className="size-3.5 animate-spin text-kumo-warning" weight="bold" />
      ) : (
        <span className={`size-2 rounded-full ${FILL[stateTone(process)]}`} />
      )}
    </span>
  );
}
