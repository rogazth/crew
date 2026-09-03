import { statusLabel } from "../lib/status";
import type { SessionStatus } from "../lib/types";

const TONE: Record<Exclude<SessionStatus, "idle">, string> = {
  working: "bg-kumo-info",
  "needs-input": "bg-kumo-warning",
  error: "bg-kumo-danger",
};

/**
 * The one signal that tells a live session from a parked one. Idle draws nothing,
 * so a quiet workspace stays quiet; `working` breathes so it reads at a glance.
 */
export function StatusDot({ status, className = "" }: { status: SessionStatus; className?: string }) {
  if (status === "idle") return null;
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      title={statusLabel(status)}
      className={`size-2 shrink-0 rounded-full ${TONE[status]} ${
        status === "working" ? "animate-status-pulse" : ""
      } ${className}`}
    />
  );
}
