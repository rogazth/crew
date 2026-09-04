import { CircleNotchIcon } from "@phosphor-icons/react";
import { statusLabel } from "../lib/status";
import type { SessionStatus } from "../lib/types";

const DOT: Partial<Record<SessionStatus, string>> = {
  "needs-input": "bg-kumo-info",
  done: "bg-kumo-info",
  error: "bg-kumo-danger",
};

/**
 * The one signal that tells a live session from a parked one. A session that has
 * nothing to report — never answered, or already read — draws nothing at all.
 */
export function StatusDot({ status, className = "" }: { status: SessionStatus; className?: string }) {
  if (status === "idle") return null;
  const dot = DOT[status];
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      title={statusLabel(status)}
      className={`flex size-3.5 shrink-0 items-center justify-center ${className}`}
    >
      {status === "working" ? (
        <CircleNotchIcon className="size-3.5 animate-spin text-kumo-warning" weight="bold" />
      ) : (
        dot && <span className={`size-2 rounded-full ${dot}`} />
      )}
    </span>
  );
}
