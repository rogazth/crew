import { CircleDashedIcon, LoaderCircleIcon } from "lucide-react";
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
 *
 * `background` is the turn over with its work still running: the same amber,
 * still, and dashed like the ring its tab wears.
 */
export function StatusDot({ status, className = "" }: { status: SessionStatus; className?: string }) {
  // An exited session has nothing more to say than an idle one.
  if (status === "idle" || status === "exited") return null;
  const dot = DOT[status];
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      title={statusLabel(status)}
      className={`flex size-3.5 shrink-0 items-center justify-center ${className}`}
    >
      {status === "working" || status === "starting" ? (
        <LoaderCircleIcon className="size-3.5 animate-spin text-warning" />
      ) : status === "background" ? (
        <CircleDashedIcon className="size-3.5 text-warning" />
      ) : (
        dot && <span className={`size-2 rounded-full ${dot}`} />
      )}
    </span>
  );
}
