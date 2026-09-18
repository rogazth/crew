import type { SessionStatus } from "@crew/fixtures";
import { statusLabel } from "@crew/fixtures";
import { cx } from "@/lib/cx";

const TONE: Record<Exclude<SessionStatus, "idle">, string> = {
  working: "var(--status-working)",
  "needs-input": "var(--status-attention)",
  done: "var(--status-unread)",
  error: "var(--status-error)",
};

/**
 * The small dot used where an avatar does not fit — a tab's trailing slot, a
 * palette row. `working` and `needs-input` share a colour and differ in shape:
 * working is a hollow ring, needs-input is solid.
 */
export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  if (status === "idle") return <span className={cx("size-2", className)} aria-hidden />;
  const colour = TONE[status];
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      title={statusLabel(status)}
      className={cx("grid size-2 place-items-center", className)}
    >
      {status === "working" ? (
        <span
          className="ring-working size-2 rounded-full"
          style={{
            mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
            WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
          }}
        />
      ) : (
        <span className="size-2 rounded-full" style={{ background: colour }} />
      )}
    </span>
  );
}
