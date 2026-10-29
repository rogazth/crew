// One plan window as the rail's card and Settings › Usage both draw it: what
// is left, when it resets, a bar with a tick where an even pace would stand,
// and a line saying whether the spend is in reserve, on pace, or ahead of it.
import { paceOf, span, tone, type Pace, type Window } from "../lib/usage";

/** Points either side of the even pace that still count as on it. */
const ON_PACE = 2;

/** `at` says when it resets as a time of day or a weekday; otherwise as a countdown. */
export function WindowRow({ window, color, at = false }: { window: Window; color: string; at?: boolean }) {
  const level = tone(window.used);
  const left = 100 - window.used;
  const pace = paceOf(window);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[13px] font-semibold tabular-nums">{left}% left</span>
        <span className="truncate text-[12px] text-text-muted">{window.label}</span>
        {window.resetsIn !== null && (
          <span className="ml-auto shrink-0 text-[11.5px] text-text-muted tabular-nums">
            {at ? `Resets ${resetAt(window.resetsIn)}` : `Resets in ${span(window.resetsIn)}`}
          </span>
        )}
      </div>
      <PaceBar left={left} pace={window.used >= 100 ? null : pace} fill={level === "neutral" ? color : `var(--color-${level})`} />
      <PaceLine window={window} pace={pace} />
    </div>
  );
}

/** When a window resets: the time today, else the weekday and time, else the date. */
function resetAt(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60_000);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (minutes < 1440 && at.getDate() === new Date().getDate()) return `at ${time}`;
  if (minutes < 7 * 1440) return `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return at.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * What is left, filled from the start; the tick is where an even pace would
 * leave it now. A fill that reaches past the tick is in reserve, one that
 * stops short of it is spending ahead.
 */
function PaceBar({ left, pace, fill }: { left: number; pace: Pace | null; fill: string }) {
  const mark = pace && 100 - pace.expected;
  return (
    <div aria-hidden className="relative h-3">
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-hairline">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${left}%`, background: fill }} />
      </div>
      {mark !== null && (
        <span
          className={`absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full ring-2 ring-surface transition-[left] duration-500 ${pace!.reserve > -ON_PACE ? "bg-success" : "bg-warning"}`}
          style={{ left: `clamp(1.5px, ${mark}%, calc(100% - 1.5px))` }}
        />
      )}
    </div>
  );
}

function PaceLine({ window, pace }: { window: Window; pace: Pace | null }) {
  if (window.used >= 100) return <span className="text-[11.5px] text-danger">Limit reached</span>;
  // Too early in the window for its pace to say anything.
  if (!pace || pace.expected < 3) return null;
  const points = Math.round(Math.abs(pace.reserve));
  const [lead, leadClass] =
    pace.reserve >= ON_PACE
      ? [`${points}% in reserve`, "text-success"]
      : pace.reserve > -ON_PACE
        ? ["On pace", "text-text"]
        : [`${points}% over pace`, "text-warning"];
  const out = pace.runsOutIn;
  return (
    <span className="text-[11.5px] text-text-muted tabular-nums">
      <span className={leadClass}>{lead}</span>
      {" · "}
      {out === null ? "Lasts until reset" : `Runs out in ${span(out)}`}
    </span>
  );
}
