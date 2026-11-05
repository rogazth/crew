// Settings › Usage: each of the last 30 days as a bar of the tokens spent, every kind
// counted, against an axis that fits what is shown, with the models that spent them on
// hover. A provider's colour belongs to its limits; this chart wears the same four
// colours on every provider, so it never reads as one of them. As many days as the card
// holds; a wider card only spreads them.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { count } from "../../chrome/UsageTokens";
import { HISTORY_DAYS, axisTop, stackHeights, tokensOf, wholeTokens, type TokenCounts, type TokenDay, type TokenKind } from "../../lib/usageData";

/** Bottom to top: the scarcest tokens at the base, where they can be compared day to day. */
const PARTS: { key: TokenKind; label: string; short: string; color: string }[] = [
  { key: "output", label: "Output", short: "Out", color: "var(--color-text)" },
  { key: "input", label: "Input", short: "In", color: "light-dark(#7d7aa0, #9490ba)" },
  { key: "cacheWrite", label: "Cache writes", short: "Write", color: "light-dark(#b98f4f, #c9a45e)" },
  { key: "cacheRead", label: "Cache reads", short: "Read", color: "light-dark(#c8c8c8, #6e6e6e)" },
];
const COLOR = Object.fromEntries(PARTS.map((part) => [part.key, part.color])) as Record<TokenKind, string>;

const HEIGHT = 72;
/** A day's slot is never narrower than this. */
const MIN_SLOT = 16;
const FEWEST_DAYS = 7;
const TIP_WIDTH = 304;
/** Nearer the top of the window than this, the tooltip opens downwards. */
const TIP_ROOM = 170;
const MOST_MODELS = 6;

const niceDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
const isMonday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() === 1;

/** "claude-opus-5-5" reads "Opus 5.5"; the rest keep the name their CLI gives them. */
function modelName(id: string): string {
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?$/);
  if (!claude) return id;
  const [, family, major, minor] = claude;
  return `${family!.charAt(0).toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

export function UsageChart({ days: all, divided }: { days: TokenDay[]; divided: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(HISTORY_DAYS);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const read = () => setFits(Math.max(FEWEST_DAYS, Math.min(HISTORY_DAYS, Math.floor(element.clientWidth / MIN_SLOT))));
    read();
    const watcher = new ResizeObserver(read);
    watcher.observe(element);
    return () => watcher.disconnect();
  }, []);

  const days = all.slice(-fits);
  const totals = tokensOf(days.flatMap((day) => day.models));
  const top = axisTop(Math.max(...days.map((day) => wholeTokens(tokensOf(day.models)))));
  const shown = hover ? days[hover.index] : undefined;
  const summary = days.map((day) => `${niceDay(day.day)} ${count(wholeTokens(tokensOf(day.models)))}`).join(", ");

  return (
    <div ref={box} className={`flex flex-col gap-2 ${divided ? "border-t border-hairline pt-3" : ""}`}>
      <div className="flex items-baseline justify-between text-[12px] text-text-muted">
        <span>Last {days.length} days</span>
        <span className="tabular-nums">
          <span className="font-medium text-text">{count(wholeTokens(totals))}</span> tokens
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] leading-3 text-text-muted tabular-nums">{count(top)}</span>
        <div
          role="img"
          aria-label={`Tokens by day: ${summary}`}
          className="relative flex border-t border-b border-t-hairline border-b-border"
          style={{ height: HEIGHT }}
          onPointerLeave={() => setHover(null)}
        >
          <span className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-hairline" />
          {days.map((day, index) => (
            <div
              key={day.day}
              className="relative flex h-full flex-1 items-end justify-center"
              onPointerEnter={(event) => {
                const slot = event.currentTarget.getBoundingClientRect();
                setHover({ index, x: slot.left + slot.width / 2, y: slot.top });
              }}
            >
              <Stack tokens={tokensOf(day.models)} top={top} dim={hover !== null && hover.index !== index} />
            </div>
          ))}
        </div>
        <div className="relative h-4 text-[11px] text-text-muted tabular-nums">
          {days.map((day, index) =>
            // Near Today its label would run into this one.
            isMonday(day.day) && index > 0 && index < days.length - 3 ? (
              <span key={day.day} className="absolute -translate-x-1/2" style={{ left: `${((index + 0.5) / days.length) * 100}%` }}>
                {niceDay(day.day)}
              </span>
            ) : null,
          )}
          <span className="absolute right-0 font-medium text-text">Today</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-text-muted tabular-nums">
        {PARTS.map((part) => (
          <span key={part.key} className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: part.color }} />
            {part.label} <span className="font-medium text-text">{count(totals[part.key])}</span>
          </span>
        ))}
      </div>

      {hover && shown && createPortal(<Tip day={shown} today={hover.index === days.length - 1} x={hover.x} y={hover.y} />, document.body)}
    </div>
  );
}

function Stack({ tokens, top, dim }: { tokens: TokenCounts; top: number; dim: boolean }) {
  const parts = stackHeights(tokens, top, HEIGHT, PARTS.map((part) => part.key));
  if (parts.length === 0) return null;
  return (
    <div className="flex w-[7px] flex-col-reverse gap-px overflow-hidden rounded-t-[2px] transition-opacity duration-100" style={{ opacity: dim ? 0.4 : 1 }}>
      {parts.map((part) => (
        <span key={part.key} style={{ height: part.height, background: COLOR[part.key] }} />
      ))}
    </div>
  );
}

/** A portal, so a card's edge or the page's scroll never clips it. */
function Tip({ day, today, x, y }: { day: TokenDay; today: boolean; x: number; y: number }) {
  const models = [...day.models].sort((a, b) => wholeTokens(b) - wholeTokens(a)).slice(0, MOST_MODELS);
  const hidden = day.models.length - models.length;
  const totals = tokensOf(day.models);
  const left = Math.min(window.innerWidth - TIP_WIDTH - 8, Math.max(8, x - TIP_WIDTH / 2));
  const below = y < TIP_ROOM;
  return (
    <div
      className={`pointer-events-none fixed z-50 flex flex-col gap-1.5 rounded-lg bg-surface p-2 text-[11px] shadow-float tabular-nums ${below ? "" : "-translate-y-full"}`}
      style={{ left, top: below ? y + HEIGHT + 6 : y - 6, width: TIP_WIDTH }}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{today ? "Today" : niceDay(day.day)}</span>
        <span className="text-text-muted">
          {models.length === 0 ? (
            "No usage"
          ) : (
            <>
              <span className="font-medium text-text">{count(wholeTokens(totals))}</span> tokens
            </>
          )}
        </span>
      </div>
      {models.length > 0 && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_repeat(4,44px)] gap-x-1.5 gap-y-0.5 border-t border-hairline pt-1.5">
            <span />
            {PARTS.map((part) => (
              <span key={part.key} className="flex items-center justify-end gap-1 text-text-muted">
                <span className="size-1.5 rounded-[2px]" style={{ background: part.color }} />
                {part.short}
              </span>
            ))}
            {models.map((model) => (
              <TipRow key={model.model} name={modelName(model.model)} tokens={model} />
            ))}
            {day.models.length > 1 && <TipRow name="Total" tokens={totals} strong />}
          </div>
          {hidden > 0 && <span className="text-text-muted">and {hidden} more</span>}
        </>
      )}
    </div>
  );
}

function TipRow({ name, tokens, strong = false }: { name: string; tokens: TokenCounts; strong?: boolean }) {
  return (
    <>
      <span className={`truncate ${strong ? "font-medium" : ""}`}>{name}</span>
      {PARTS.map((part) => (
        <span key={part.key} className={`text-right ${strong ? "font-medium" : "text-text-muted"}`}>
          {tokens[part.key] === 0 ? "–" : count(tokens[part.key])}
        </span>
      ))}
    </>
  );
}
