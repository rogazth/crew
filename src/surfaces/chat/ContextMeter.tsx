import { tokenCount, useContextMeter } from "../../lib/contextMeter";
import { providerOf } from "../../lib/providers";

const R = 6;
const C = 2 * Math.PI * R;

function Ring({ share }: { share: number }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={R}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={`${share * C} ${C}`}
        strokeLinecap="round"
        className="transition-[stroke-dasharray] duration-500"
      />
    </svg>
  );
}

/**
 * How full the session's context window is: a ring and its percentage, with
 * a card on hover that says the window and when the provider compacts.
 * Nothing until a reading with a window has come. A count from before a
 * compaction is dimmed, since the session holds less than it says.
 */
export function ContextMeter({ sessionId, provider }: { sessionId: string; provider: string }) {
  const reading = useContextMeter(sessionId);
  const window = reading?.window;
  if (!reading || !window) return null;
  const { used, autoCompactAt, stale } = reading;
  const share = Math.min(1, used / window);
  const percent = Math.round(share * 100);
  const label = providerOf(provider)?.label ?? provider;
  return (
    <span data-context-meter data-session={sessionId} className="group relative flex h-6 cursor-default items-center px-1.5">
      <span className={`flex items-center gap-1 text-[11.5px] text-text-muted tabular-nums ${stale ? "opacity-50" : ""}`}>
        <Ring share={share} />
        {percent}%
      </span>
      <span className="invisible absolute bottom-full left-0 z-30 mb-2 w-64 translate-y-1 rounded-xl bg-surface p-3 opacity-0 shadow-float ring-1 ring-border transition-[opacity,translate,visibility] duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
        <span className="flex items-baseline justify-between">
          <span className="text-[12px] text-text-muted">Context window</span>
          <span className="text-[12px] text-text-muted tabular-nums">{percent}%</span>
        </span>
        <span className="mt-1 block text-[15px] font-medium tabular-nums">
          {tokenCount(used)} <span className="text-[12.5px] font-normal text-text-muted">of {tokenCount(window)}</span>
        </span>
        <span className="mt-2.5 block h-1 w-full overflow-hidden rounded-full bg-hairline">
          <span className="block h-full rounded-full bg-text-muted transition-[width] duration-500" style={{ width: `${share * 100}%` }} />
        </span>
        <span className="mt-2 block text-[11.5px] leading-4 text-text-muted">
          {stale
            ? "Counted before the last compaction; the next answer counts it again."
            : autoCompactAt
              ? `Compacts on its own at ${tokenCount(autoCompactAt)}.`
              : `${label} compacts on its own near the end.`}
        </span>
      </span>
    </span>
  );
}
