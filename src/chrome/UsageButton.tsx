// The providers' plan usage at the rail's foot: a ring per chosen provider (or
// one with the tightest limit), and a card with each chosen provider's windows,
// when each resets and, at the current pace, whether it lasts until then.
// Mounting it also keeps the usage store fed.
import { Popover } from "@base-ui/react/popover";
import { ArrowRightIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";
import { IconButton } from "./kit";
import { ProviderIcon } from "./ProviderIcon";
import {
  BAR,
  INDICATOR,
  STROKE,
  TEXT,
  clock,
  refreshUsage,
  runsOutIn,
  span,
  tightest,
  tone,
  updatedLabel,
  useFreshness,
  useNow,
  useReadings,
  useUsageSync,
  colorOf,
  inOrder,
  peak,
  shownInOrder,
  useRings,
  type RingConfig,
  type Reading,
  type Window,
} from "../lib/usage";
import { hasWindows, ofProvider } from "../lib/usageData";
import { Tokens } from "./UsageTokens";

export function UsageButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  useUsageSync();
  const rings = useRings();
  const fresh = useFreshness();
  const all = useReadings();
  const now = useNow();
  const chosen = shownInOrder(rings);
  const readings = inOrder(rings, all).filter((reading) => chosen.includes(reading.provider));
  const top = tightest(readings);
  if (readings.length === 0) return null;
  const level = tone(top?.window.used ?? 0);
  const label = top
    ? `Usage: ${top.reading.name} ${top.window.label.toLowerCase()} at ${top.window.used}%`
    : "Usage";
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={350}
        aria-label={label}
        data-tauri-drag-region="false"
        className="grid size-9 shrink-0 place-items-center rounded-xl text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:bg-selected"
      >
        {INDICATOR === "rings" || !top ? <Rings config={rings} /> : <Ring value={top.window.used / 100} level={level} />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="right" align="end" sideOffset={12} className="z-50">
          <Popover.Popup className="w-[340px] origin-(--transform-origin) overflow-hidden rounded-float bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <div className="flex items-center gap-2 pt-2.5 pr-2 pb-1.5 pl-4">
              <span className="text-[13px] font-semibold">Usage</span>
              <span className="ml-auto text-[11.5px] text-text-muted">{fresh.refreshing ? "Refreshing…" : updatedLabel(fresh.updatedAt, now)}</span>
              <IconButton
                icon={RefreshCwIcon}
                label="Refresh usage"
                className={`size-7 ${fresh.refreshing ? "[&_svg]:animate-spin" : ""}`}
                onClick={() => void refreshUsage(true)}
              />
            </div>
            <div className="flex flex-col gap-1 px-2">
              {readings.map((reading) => (
                <ProviderUsage
                  key={`${reading.provider}|${reading.account ?? ""}`}
                  reading={reading}
                  color={colorOf(rings, reading.provider)}
                />
              ))}
            </div>
            <Popover.Close
              onClick={onOpenSettings}
              className="mt-2 flex w-full items-center justify-between border-t border-hairline px-4 py-2.5 text-[12px] text-text-muted outline-none transition-colors hover:bg-hover hover:text-text"
            >
              Details in Settings
              <ArrowRightIcon className="size-3.5" />
            </Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ProviderUsage({ reading, color }: { reading: Reading; color: string }) {
  if (!hasWindows(reading) && reading.tokens === null) {
    return (
      <div className="flex items-center gap-2 rounded-xl px-2 py-2 opacity-55">
        <ProviderIcon provider={reading.provider} className="size-4" />
        <span className="text-[12.5px] font-medium">{reading.name}</span>
        <span className="ml-auto truncate text-[11.5px] text-text-muted">{reading.plan ?? "Doesn't report usage"}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-card px-2.5 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={reading.provider} className="size-4" />
        <span className="text-[12.5px] font-medium">{reading.name}</span>
        <span className="text-[11.5px] text-text-muted">{reading.plan}</span>
        {INDICATOR === "rings" && hasWindows(reading) && (
          <span aria-hidden className="ml-auto size-2 rounded-full" style={{ background: color }} />
        )}
      </div>
      {reading.windows.map((window) => (
        <WindowRow key={window.id} window={window} />
      ))}
      <Tokens reading={reading} />
    </div>
  );
}

function WindowRow({ window }: { window: Window }) {
  const level = tone(window.used);
  const out = runsOutIn(window);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[12px]">
        <span>{window.label}</span>
        <span className={`tabular-nums ${level === "neutral" ? "text-text-muted" : TEXT[level]}`}>{window.used}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-hairline">
        <div className={`h-full rounded-full ${BAR[level]}`} style={{ width: `${window.used}%` }} />
      </div>
      <div className="flex justify-between text-[11px] text-text-muted tabular-nums">
        <span>{window.resetsIn === null ? "Reset time unknown" : `Resets in ${span(window.resetsIn)}`}</span>
        {out === null ? (
          <span>Lasts until reset</span>
        ) : (
          <span className={TEXT[tone(Math.max(window.used, 75))]}>
            Runs out ~{clock(out)}
          </span>
        )}
      </div>
    </div>
  );
}

function Ring({ value, level }: { value: number; level: keyof typeof STROKE }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative grid size-[26px] place-items-center">
      <svg viewBox="0 0 26 26" className="absolute inset-0 size-[26px] -rotate-90" aria-hidden>
        <circle cx="13" cy="13" r={r} fill="none" strokeWidth="2" className="stroke-current opacity-20" />
        <circle
          cx="13"
          cy="13"
          r={r}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value)}
          className={`${STROKE[level]} transition-[stroke-dashoffset] duration-500`}
        />
      </svg>
      <span className="text-[7.5px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
        {Math.round(value * 100)}
      </span>
    </span>
  );
}

/**
 * One ring per provider that reports usage, outermost first, each filled to
 * that provider's tightest window. Past 90% a ring turns red, whatever its colour.
 */
export function Rings({ config }: { config: RingConfig }) {
  const readings = useReadings();
  const rings = shownInOrder(config).flatMap((id) => {
    const reading = ofProvider(readings, id);
    return reading && hasWindows(reading) ? [{ id, color: colorOf(config, id), used: peak(reading) }] : [];
  });
  if (rings.length === 0) return <GaugeIcon className="size-[18px]" aria-hidden />;
  const width = 2.75;
  const gap = 0.75;
  return (
    <svg viewBox="0 0 26 26" className="size-[26px] -rotate-90" aria-hidden>
      {rings.map((ring, index) => {
        const r = 13 - width / 2 - index * (width + gap);
        const c = 2 * Math.PI * r;
        const color = ring.used >= 90 ? "var(--color-danger)" : ring.color;
        return (
          <g key={ring.id}>
            <circle cx="13" cy="13" r={r} fill="none" strokeWidth={width} stroke={color} strokeOpacity="0.22" />
            <circle
              cx="13"
              cy="13"
              r={r}
              fill="none"
              strokeWidth={width}
              strokeLinecap="round"
              stroke={color}
              strokeDasharray={c}
              strokeDashoffset={c * (1 - ring.used / 100)}
              className="transition-[stroke-dashoffset] duration-500"
            />
          </g>
        );
      })}
    </svg>
  );
}
