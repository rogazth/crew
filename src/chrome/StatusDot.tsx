import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { useDarkScheme } from "../hooks/useDarkScheme";
import { statusLabel } from "../lib/status";
import type { SessionStatus } from "../lib/types";

const DOT: Partial<Record<SessionStatus, string>> = {
  "needs-input": "bg-info",
  done: "bg-info",
  error: "bg-danger",
};

/**
 * The one signal that tells a live session from a parked one. A session that has
 * nothing to report — never answered, or already read — draws nothing at all.
 *
 * Colour is kept for what wants you: blue is something waiting for you — a
 * question, an approval, a finished turn you have not read — and red failed.
 * Work that wants nothing is ink: three dots rising in turn while an agent
 * works, the one thing in the chrome that moves.
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
        <TypingDots />
      ) : (
        <span className={`size-2 rounded-full ${DOT[status]}`} />
      )}
    </span>
  );
}

/** Three dots in ink, rising in turn: a turn running, or a call still open. */
/**
 * The dotted orb that turns while the agent works, in the inline size. The
 * scheme is passed in: the orb's own guess reads the `dark` class the root
 * has always carried, whatever the app shows.
 */
export function WorkOrb({ state, label, className }: { state: OrbState; label: string; className?: string }) {
  const dark = useDarkScheme();
  return <ThinkingOrb state={state} size={20} theme={dark ? "dark" : "light"} aria-label={label} {...(className ? { className } : {})} />;
}

export function TypingDots({ className = "" }: { className?: string }) {
  return (
    <span className={`crew-typing ${className}`}>
      <span />
      <span />
      <span />
    </span>
  );
}
