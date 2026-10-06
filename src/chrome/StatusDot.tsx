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
 * Colour is kept for what wants you: amber waits on you, blue finished out of
 * sight, red failed. Work that wants nothing is ink: three dots rising in turn
 * while a turn runs, the one thing in the chrome that moves, and a hollow dot,
 * still, once the turn is over with its work running on in the background.
 */
export function StatusDot({ status, className = "" }: { status: SessionStatus; className?: string }) {
  // An exited session has nothing more to say than an idle one.
  if (status === "idle" || status === "exited") return null;
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      title={statusLabel(status)}
      className={`flex size-3.5 shrink-0 items-center justify-center ${className}`}
    >
      {status === "working" || status === "starting" ? (
        <span className="crew-typing">
          <span />
          <span />
          <span />
        </span>
      ) : status === "background" ? (
        <span className="size-2 rounded-full border-[1.5px] border-text-muted" />
      ) : (
        <span className={`size-2 rounded-full ${DOT[status]}`} />
      )}
    </span>
  );
}
