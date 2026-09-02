import type { SessionStatus } from "../lib/types";

const TONE: Record<Exclude<SessionStatus, "idle">, string> = {
  working: "bg-kumo-info",
  "needs-input": "bg-kumo-warning",
  error: "bg-kumo-danger",
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  working: "Working",
  "needs-input": "Needs input",
  error: "Error",
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
      aria-label={STATUS_LABEL[status]}
      title={STATUS_LABEL[status]}
      className={`size-2 shrink-0 rounded-full ${TONE[status]} ${
        status === "working" ? "animate-status-pulse" : ""
      } ${className}`}
    />
  );
}
