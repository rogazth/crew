import clsx from "clsx";
import { statusLabel, type SessionStatus } from "@crew/fixtures";

/**
 * The spinner replacement: three cells marching. It reads as activity at a
 * glance and as texture from across the room, and it never spins.
 */
export function Bars({ className }: { className?: string }) {
  return (
    <span className={clsx("bars", className)} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

const TONE: Record<SessionStatus, string> = {
  idle: "text-ink-4",
  working: "text-amber",
  "needs-input": "text-amber",
  done: "text-done",
  error: "text-red",
};

/**
 * `working` and `needs-input` share a hue and differ in shape, so they are
 * distinguishable without colour vision.
 */
export function StatusMark({
  status,
  className,
  title = true,
}: {
  status: SessionStatus;
  className?: string;
  title?: boolean;
}) {
  const label = statusLabel(status);
  const shared = clsx(
    "inline-grid size-[10px] shrink-0 place-items-center font-mono text-xs leading-none",
    TONE[status],
    className,
  );
  if (status === "idle") return <span className={shared} aria-hidden />;
  return (
    <span className={shared} role="img" aria-label={label} title={title ? label : undefined}>
      {status === "working" ? (
        <Bars />
      ) : status === "error" ? (
        <svg viewBox="0 0 10 10" className="size-[8px]" aria-hidden>
          <path d="M2 2 8 8M8 2 2 8" stroke="currentColor" strokeWidth="1.4" fill="none" />
        </svg>
      ) : (
        <span className="block size-[6px] rounded-full bg-current" />
      )}
    </span>
  );
}

/** The sidebar's busy signal: a rule that fills left to right and resets. */
export function ProgressRule({ active }: { active: boolean }) {
  if (!active) return null;
  return <span className="progress-rule pointer-events-none absolute inset-x-0 bottom-0" aria-hidden />;
}
