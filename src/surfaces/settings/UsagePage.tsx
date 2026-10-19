// Usage: each provider's plan limits in full (every window, when it resets,
// where the pace lands it, the last week day by day), which providers get a
// ring on the rail, and when to be told. Not reachable until S2 of
// docs/plans/2026-10-19-design-system-finish.md reads real usage.
import { Popover } from "@base-ui/react/popover";
import { CheckIcon, GripVerticalIcon, RefreshCwIcon, RotateCcwIcon, TrendingUpIcon } from "lucide-react";
import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { PointerActivationConstraints } from "@dnd-kit/dom";
import { PointerSensor } from "@dnd-kit/react";
import { Button, Select } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { SortableItem, SortableList } from "../../chrome/SortableList";
import { Rings } from "../../chrome/UsageButton";
import {
  MAX_RINGS,
  RING_COLORS,
  TEXT,
  canToggleRing,
  clock,
  colorOf,
  inOrder,
  refreshUsage,
  reorderRings,
  resetRings,
  runsOutIn,
  setRingColor,
  toggleRing,
  tone,
  updatedLabel,
  useFreshness,
  useRings,
  type RingConfig,
  type Reading,
  type Window,
} from "../../lib/usage";
import { Group, Heading, RAISED, Row, SettingsPage, ToggleRow, toast } from "./ui";

type Plan = Extract<Reading, { plan: string }>;

const REFRESH = [
  { value: "1", label: "Every minute" },
  { value: "5", label: "Every 5 minutes" },
  { value: "15", label: "Every 15 minutes" },
] as const;

/** The page itself holds no state: each part subscribes to what it draws, so a drag or a refresh redraws only that part. */
export function UsagePage() {
  return (
    <SettingsPage title="Usage" actions={<RefreshButton />}>
      <PlanLimits />

      <RingsSection />

      <Alerts />
    </SettingsPage>
  );
}

function RefreshButton() {
  const fresh = useFreshness();
  const refresh = () => void refreshUsage().then(() => toast("Usage updated"));
  return (
    <Button variant="ghost" icon={RefreshCwIcon} loading={fresh.refreshing} onClick={refresh}>
      Refresh
    </Button>
  );
}

function PlanLimits() {
  const fresh = useFreshness();
  const rings = useRings();
  const plans = inOrder(rings).filter((reading): reading is Plan => reading.plan !== null);
  const silent = inOrder(rings).filter((reading) => reading.plan === null);
  return (
      <section className="flex flex-col gap-2" data-setting="usage-limits">
        <Heading
          title="Plan limits"
          action={<span className="text-[11.5px] text-text-muted">{updatedLabel(fresh.updatedAt)}</span>}
        />
        <div className="flex flex-col gap-2.5">
          {plans.map((reading) => (
            <ProviderCard key={reading.provider} reading={reading} color={colorOf(rings, reading.provider)} />
          ))}
          {silent.map((reading) => (
            <div key={reading.provider} className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-text-muted">
              <ProviderIcon provider={reading.provider} className="size-5 opacity-60" />
              <span className="font-medium">{reading.name}</span>
              <span className="ml-auto text-[12px]">No usage data</span>
            </div>
          ))}
        </div>
      </section>
  );
}

/* ── One provider ───────────────────────────────────────────────────── */

/** Memoised: a reorder or another provider's colour change leaves this card alone. */
const ProviderCard = memo(function ProviderCard({ reading, color }: { reading: Plan; color: string }) {
  return (
    <div className={`flex flex-col gap-3 rounded-xl p-3 ${RAISED}`}>
      <div className="flex items-center gap-2 px-0.5">
        <ProviderIcon provider={reading.provider} className="size-4" />
        <span className="font-semibold">{reading.name}</span>
        <span className="rounded-md bg-fill px-1.5 py-px text-[11px] font-medium text-text-muted">{reading.plan}</span>
        <span className="ml-auto truncate text-[12px] text-text-muted">{reading.account}</span>
      </div>

      <div className="grid grid-cols-1 gap-2 @[560px]:grid-cols-2">
        {reading.windows.map((window) => (
          <WindowTile key={window.label} window={window} color={color} />
        ))}
      </div>

      <Week reading={reading} color={color} />
    </div>
  );
});

function WindowTile({ window, color }: { window: Window; color: string }) {
  const level = tone(window.used);
  const out = runsOutIn(window);
  const fill = level === "neutral" ? color : `var(--color-${level})`;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-card px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-text-muted">{window.label}</span>
        <span className="text-[11.5px] text-text-muted tabular-nums">Resets {resetAt(window.resetsIn)}</span>
      </div>
      <span className="text-[18px] leading-6 font-semibold tracking-[-0.02em] tabular-nums">{window.used}%</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-hairline">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${window.used}%`, background: fill }} />
      </div>
      <span className={`flex items-center gap-1.5 text-[11.5px] ${out === null ? "text-text-muted" : TEXT[tone(Math.max(window.used, 75))]}`}>
        <TrendingUpIcon className="size-3.5 shrink-0" />
        {out === null
          ? "Lasts until reset"
          : `Runs out ~${clock(out)}`}
      </span>
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

/* ── The last seven days ────────────────────────────────────────────── */

/**
 * One bar per day, the share of the provider's longest window spent that day,
 * in the provider's colour. A single series, so the heading names it and no
 * legend is needed; each bar says its day and value on hover.
 */
function Week({ reading, color }: { reading: Plan; color: string }) {
  const top = Math.max(...reading.history, 1);
  const [now] = useState(() => Date.now());
  const days = reading.history.map((value, index) => {
    const at = new Date(now - (reading.history.length - 1 - index) * 86_400_000);
    return { value, day: at.toLocaleDateString([], { weekday: "short" }), today: index === reading.history.length - 1 };
  });
  return (
    <div className="flex flex-col gap-1.5 px-0.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-text-muted">Last 7 days</span>
      </div>
      <div className="flex h-12 items-end gap-1 border-b border-hairline">
        {days.map((day) => (
          <div key={day.day} className="group relative flex h-full flex-1 items-end justify-center">
            <div
              className="w-full rounded-t-[4px] transition-opacity group-hover:opacity-80"
              style={{ height: day.value ? `${(day.value / top) * 100}%` : 2, background: day.value ? color : "var(--color-hairline)" }}
            />
            <span className="pointer-events-none absolute bottom-full z-10 mb-1 rounded-md bg-surface px-2 py-1 text-[11px] whitespace-nowrap opacity-0 shadow-float transition-opacity group-hover:opacity-100">
              {day.day} · <span className="font-medium tabular-nums">{day.value}%</span>
            </span>
          </div>
        ))}
      </div>
      <div className="flex gap-1">
        {days.map((day) => (
          <span key={day.day} className={`flex-1 text-center text-[11px] ${day.today ? "font-medium text-text" : "text-text-muted"}`}>
            {day.today ? "Today" : day.day}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Rings on the rail ──────────────────────────────────────────────── */

/** A press held this long picks the row up; anything shorter is a click, which ticks it. */
const HOLD = 250;

const RING_SENSORS = [
  PointerSensor.configure({
    activationConstraints: [new PointerActivationConstraints.Delay({ value: HOLD, tolerance: 6 })],
    // The colour swatch is its own control; a press on it never drags the row.
    preventActivation: (event) => event.target instanceof Element && event.target.closest("[data-no-drag]") !== null,
  }),
];

/**
 * The rail's rings: a click ticks a provider on or off, a long press picks it
 * up to move its ring in or out, and the swatch sets its colour, which follows
 * it everywhere usage is drawn.
 */
function RingsSection() {
  const rings = useRings();
  const choices = inOrder(rings).filter((reading): reading is Plan => reading.plan !== null);
  const pressed = useRef(0);
  return (
    <section className="flex flex-col gap-2" data-setting="usage-rings">
      <Heading
        title="Rings on the rail"
        action={
          <button
            type="button"
            onClick={resetRings}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
          >
            <RotateCcwIcon className="size-3" />
            Reset
          </button>
        }
      />
      <div className="flex items-stretch gap-2.5">
        <div className="grid w-24 shrink-0 place-items-center rounded-xl bg-card">
          <span className="grid size-14 place-items-center rounded-2xl bg-rail [&_svg]:size-10!">
            <Rings config={rings} />
          </span>
        </div>
        <div className="min-w-0 flex-1 rounded-xl bg-card p-1">
          <SortableList ids={choices.map((reading) => reading.provider)} onReorder={reorderRings} sensors={RING_SENSORS}>
            {choices.map((reading, index) => {
              const on = rings.shown.includes(reading.provider);
              const disabled = !canToggleRing(reading.provider);
              return (
                <SortableItem key={reading.provider} id={reading.provider} index={index} group="usage-ring">
                  <div className="group flex h-10 items-center gap-1 rounded-lg pr-1.5 hover:bg-hover">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-disabled={disabled}
                      title={disabled ? (on ? "At least one" : `Up to ${MAX_RINGS}`) : undefined}
                      onPointerDown={() => (pressed.current = Date.now())}
                      // A long press was a drag, not a click.
                      onClick={() => Date.now() - pressed.current < HOLD && !disabled && toggleRing(reading.provider)}
                      className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2.5 rounded-lg pl-1 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-focus/50"
                    >
                      <GripVerticalIcon aria-hidden className="size-3.5 shrink-0 text-placeholder group-hover:text-text-muted" />
                      <span
                        className={`grid size-4 shrink-0 place-items-center rounded-[5px] transition-colors ${
                          on ? "bg-text text-inverse" : `ring-1 ring-border-strong ${disabled ? "opacity-40" : ""}`
                        }`}
                      >
                        {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
                      </span>
                      <ProviderIcon provider={reading.provider} className="size-4" />
                      <span className={`min-w-0 flex-1 truncate ${on ? "font-medium" : "text-text-muted"}`}>{reading.name}</span>
                    </button>
                    <ColorPicker provider={reading.provider} name={reading.name} config={rings} />
                  </div>
                </SortableItem>
              );
            })}
          </SortableList>
        </div>
      </div>
    </section>
  );
}

/**
 * A provider's colour: a swatch that opens the presets (one another provider
 * wears is taken) and, under them, a picker for any colour at all.
 */
function ColorPicker({ provider, name, config }: { provider: string; name: string; config: RingConfig }) {
  const current = config.colors[provider];
  const taken = new Set(Object.entries(config.colors).flatMap(([id, color]) => (id === provider ? [] : [color])));
  const custom = current?.startsWith("#") ? current : null;
  return (
    <Popover.Root>
      <Popover.Trigger
        data-no-drag
        aria-label={`${name}'s colour`}
        className="grid size-7 shrink-0 place-items-center rounded-md outline-none hover:bg-selected focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:bg-selected"
      >
        <span className="size-3.5 rounded-full shadow-[inset_0_0_0_1px_oklch(0%_0_0/0.12)]" style={{ background: colorOf(config, provider) }} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="flex w-[196px] origin-(--transform-origin) flex-col gap-2 rounded-xl bg-surface p-2 shadow-float outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <div className="grid grid-cols-4 gap-1">
              {RING_COLORS.map((color) => {
                const on = color.id === current;
                const off = taken.has(color.id);
                return (
                  <button
                    key={color.id}
                    type="button"
                    disabled={off}
                    aria-label={off ? `${color.label}, in use` : color.label}
                    title={off ? `${color.label} · in use` : color.label}
                    onClick={() => setRingColor(provider, color.id)}
                    className="grid h-9 place-items-center rounded-lg outline-none enabled:hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-default"
                  >
                    <Swatch color={color.value} on={on} off={off} />
                  </button>
                );
              })}
            </div>
            <div className="border-t border-hairline pt-2">
              <CustomColor
                value={custom ?? toHex(colorOf(config, provider))}
                active={custom !== null}
                onChange={(hex) => setRingColor(provider, hex)}
              />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Swatch({ color, on, off = false }: { color: string; on: boolean; off?: boolean }) {
  return (
    <span
      className={`grid size-5 place-items-center rounded-full text-white ${off ? "opacity-25" : ""} ${
        on ? "ring-2 ring-text ring-offset-2 ring-offset-surface" : ""
      }`}
      style={{ background: color }}
    >
      {on && <CheckIcon className="size-3" strokeWidth={3} />}
    </span>
  );
}

/* ── Custom colour ──────────────────────────────────────────────────── */

type Hsv = { h: number; s: number; v: number };

/** A preset's light step, as the custom picker's starting point. */
function toHex(color: string): string {
  return color.match(/#[0-9a-f]{6}/i)?.[0] ?? "#64748b";
}

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Drags across an element, reporting where the pointer is in it, 0‥1 on each axis. */
function useDrag(onMove: (x: number, y: number) => void) {
  return (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);
    const report = (e: { clientX: number; clientY: number }) => {
      const box = el.getBoundingClientRect();
      onMove(
        Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
        Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
      );
    };
    report(event);
    const move = (e: PointerEvent) => report(e);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
}

/** Any colour: saturation and brightness in the square, hue on the bar, or typed as hex. */
function CustomColor({ value, active, onChange }: { value: string; active: boolean; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [draft, setDraft] = useState<string | null>(null);
  const hex = hsvToHex(hsv);
  const pick = (next: Hsv) => {
    setHsv(next);
    setDraft(null);
    onChange(hsvToHex(next));
  };
  const square = useDrag((x, y) => pick({ ...hsv, s: x, v: 1 - y }));
  const hue = useDrag((x) => pick({ ...hsv, h: x * 359 }));
  return (
    <div className="flex flex-col gap-2">
      <div
        onPointerDown={square}
        className="relative h-24 cursor-crosshair touch-none rounded-lg"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}
      >
        <span
          className="pointer-events-none absolute size-3 -translate-1/2 rounded-full ring-2 ring-white shadow-[0_0_0_3px_oklch(0%_0_0/0.25)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
        />
      </div>
      <div
        onPointerDown={hue}
        className="relative h-3 cursor-pointer touch-none rounded-full"
        style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-3.5 -translate-1/2 rounded-full bg-white shadow-[0_0_0_1px_oklch(0%_0_0/0.2),0_1px_3px_oklch(0%_0_0/0.3)]"
          style={{ left: `${(hsv.h / 359) * 100}%` }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Swatch color={hex} on={false} />
        <input
          aria-label="Hex colour"
          value={draft ?? hex.toUpperCase()}
          spellCheck={false}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const full = /^#?[0-9a-f]{6}$/i.test(text) ? `#${text.replace("#", "").toLowerCase()}` : null;
            if (full) {
              setHsv(hexToHsv(full));
              onChange(full);
            }
          }}
          onBlur={() => setDraft(null)}
          className="h-7 min-w-0 flex-1 rounded-md bg-canvas px-2 font-mono text-[12px] ring ring-border outline-none focus:ring-focus/50"
        />
        {active && <span className="text-[11px] text-text-muted">Custom</span>}
      </div>
    </div>
  );
}

/* ── Alerts ─────────────────────────────────────────────────────────── */

function Alerts() {
  const [notify, setNotify] = useState(true);
  const [composer, setComposer] = useState(true);
  const [every, setEvery] = useState<(typeof REFRESH)[number]["value"]>("5");
  return (
    <Group title="Alerts" id="usage-alerts">
      <ToggleRow
        checked={notify}
        onChange={setNotify}
        label="Notify at 90%"
      />
      <ToggleRow
        checked={composer}
        onChange={setComposer}
        label="Warn in the composer at 85%"
      />
      <Row label="Refresh">
        <Select value={every} options={[...REFRESH]} onChange={setEvery} label="Refresh usage" />
      </Row>
    </Group>
  );
}
