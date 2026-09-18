import { memo, type CSSProperties } from "react";
import { statusLabel } from "@crew/fixtures";
import type { SessionStatus } from "@crew/fixtures";
import { cx } from "@/lib/cx";

const TONE: Record<Exclude<SessionStatus, "idle">, string> = {
  working: "var(--status-attention)",
  "needs-input": "var(--status-attention)",
  done: "var(--accent)",
  error: "var(--status-danger)",
};

/**
 * One component, four states, and the only looping animation in the app.
 * `working` breathes; `needs-input` is the same hue held still inside a ring, so
 * the two read as one family and still differ at a glance.
 */
export const StatusDot = memo(function StatusDot({
  status,
  className,
}: {
  status: SessionStatus;
  className?: string;
}) {
  if (status === "idle") return null;
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      data-status={status}
      className={cx("ink-dot", className)}
      style={{ "--dot": TONE[status] } as CSSProperties}
    >
      {status === "working" && <span className="ink-dot-halo" />}
      {status === "needs-input" && <span className="ink-dot-ring" />}
      <span className="ink-dot-core" />
    </span>
  );
});

/** The spinner's replacement: the same breathing dot, on its own. */
export function Pulse({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label ?? "Working"}
      data-status="working"
      className={cx("ink-dot", className)}
      style={{ "--dot": "var(--status-attention)" } as CSSProperties}
    >
      <span className="ink-dot-halo" />
      <span className="ink-dot-core" />
    </span>
  );
}
