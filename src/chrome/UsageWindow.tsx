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

const MARKS = "repeating-linear-gradient(to right, #000 0 3px, transparent 3px 5px)";

/**
 * What is left, as thin marks filled from the start; the caret is where an even
 * pace would leave it now. A fill that reaches past the caret is in reserve, one
 * that stops short of it is spending ahead. Hovering anywhere on the bar says what
 * the caret means, over the caret itself; it is drawn here, not in a portal, so it
 * shows at once on the page and in the rail's popup alike.
 */
function PaceBar({ left, pace, fill }: { left: number; pace: Pace | null; fill: string }) {
  const mark = pace && 100 - pace.expected;
  const say = mark === null ? null : `Even pace: ${Math.round(mark)}% left`;
  const side = mark === null ? "" : mark < 18 ? "left-0" : mark > 82 ? "right-0" : "-translate-x-1/2";
  return (
    <div data-pace-bar className="group/pace relative h-4" role="img" aria-label={say ? `${left}% left. ${say}` : `${left}% left`}>
      <div className="absolute inset-x-0 top-1.5 bottom-0" style={{ maskImage: MARKS, WebkitMaskImage: MARKS }}>
        <div className="absolute inset-0 bg-text/12" />
        <div className="absolute inset-y-0 left-0 transition-[width] duration-500" style={{ width: `${left}%`, background: fill }} />
      </div>
      {mark !== null && (
        <>
          <span
            data-pace-caret
            className="absolute top-0 h-[5px] w-2 -translate-x-1/2 bg-danger transition-[left] duration-500 [clip-path:polygon(0_0,100%_0,50%_100%)]"
            style={{ left: `clamp(4px, ${mark}%, calc(100% - 4px))` }}
          />
          <span
            data-pace-tip
            className={`pointer-events-none absolute bottom-full z-20 mb-1 rounded-lg bg-accent px-2 py-1 text-[12px] whitespace-nowrap text-inverse opacity-0 transition-opacity duration-100 group-hover/pace:opacity-100 ${side}`}
            style={side === "-translate-x-1/2" ? { left: `${mark}%` } : undefined}
          >
            {say}
          </span>
        </>
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
      ? [`${points}% in reserve`, "text-text"]
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
