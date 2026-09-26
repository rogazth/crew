import { LoaderCircleIcon } from "lucide-react";
import { statusLabel } from "../lib/status";
import type { SessionStatus } from "../lib/types";

const DOT: Partial<Record<SessionStatus, string>> = {
  "needs-input": "bg-warning",
  done: "bg-info",
  error: "bg-danger",
};

/**
 * The one signal that tells a live session from a parked one. A session that has
 * nothing to report — never answered, or already read — draws nothing at all.
 *
 * `working` and `needs-input` share the amber and differ in shape: both mean
 * something is happening here, and the still one is the one waiting on you.
 * They used to be a spinner and a blue dot, which read the same from a glance
 * away as a turn that had finished and nobody had opened.
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
        <LoaderCircleIcon className="size-3.5 animate-spin text-warning" />
      ) : (
        dot && <span className={`size-2 rounded-full ${dot}`} />
      )}
    </span>
  );
}
