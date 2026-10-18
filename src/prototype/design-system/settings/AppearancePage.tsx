// PROTOTYPE — throwaway. Appearance: theme as three little windows, the
// style (the redesign's directions) as swatches, density, text size, bot faces
// and motion, with a live preview that wears every choice. Theme and style are
// real (direction.ts, useColorMode); density, text size and motion are local.
import { ArrowUpIcon, CheckIcon } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { BotAvatar } from "../../../chrome/BotAvatar";
import { Segmented } from "../../../chrome/kit";
import { useBotAvatar } from "../../../hooks/useBotAvatar";
import { useColorMode } from "../../../hooks/useColorMode";
import { BOT_AVATARS } from "../../../lib/botAvatar";
import { applyDirection, setTheme, useProto, type Direction, type Theme } from "../direction";
import { Group, Heading, RAISED, Row, SettingsPage } from "./ui";

type Density = "comfortable" | "compact";
const SIZES = [12, 13, 14, 15, 16] as const;
type Size = (typeof SIZES)[number];

/** Kept across page switches, like a real preference would be. */
let saved: { density: Density; size: Size; still: boolean } = { density: "comfortable", size: 13, still: false };

export function AppearancePage() {
  const [prefs, setPrefs] = useState(saved);
  const set = (change: Partial<typeof prefs>) => {
    saved = { ...prefs, ...change };
    setPrefs(saved);
  };
  return (
    <SettingsPage title="Appearance" wide>
      <div className="grid grid-cols-1 items-start gap-8 @[900px]:grid-cols-[minmax(0,1fr)_288px]">
        <div className="order-2 flex min-w-0 flex-col gap-8 @[900px]:order-1">
          <ThemePicker />
          <StylePicker />
          <Group title="Reading">
            <Row id="density" label="Density" description="Fit more rows in lists.">
              <Segmented<Density>
                label="Density"
                value={prefs.density}
                onChange={(density) => set({ density })}
                options={[
                  { value: "comfortable", label: "Comfortable" },
                  { value: "compact", label: "Compact" },
                ]}
              />
            </Row>
            <Row id="text-size" label="Chat text size">
              <SizeSlider value={prefs.size} onChange={(size) => set({ size })} />
            </Row>
          </Group>
          <AvatarPicker />
        </div>
        <div className="order-1 @[900px]:sticky @[900px]:top-6 @[900px]:order-2">
          <Preview {...prefs} />
        </div>
      </div>
    </SettingsPage>
  );
}

/* ── Theme ──────────────────────────────────────────────────────────── */

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function ThemePicker() {
  const { theme } = useProto();
  const color = useColorMode();
  return (
    <section className="flex flex-col gap-2" data-setting="theme">
      <Heading title="Theme" />
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
        {THEMES.map((t) => (
          <PickCard
            key={t.id}
            on={theme === t.id}
            onClick={() => {
              setTheme(t.id);
              if (color.available) color.update(t.id);
            }}
            label={t.label}
          >
            <div className="relative aspect-[16/10] overflow-hidden rounded-[8px]">
              {t.id === "system" ? (
                <>
                  <MiniApp scheme="light" />
                  <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
                    <MiniApp scheme="dark" />
                  </div>
                </>
              ) : (
                <MiniApp scheme={t.id} />
              )}
            </div>
          </PickCard>
        ))}
      </div>
    </section>
  );
}

/**
 * A tiny window drawn with the live tokens under a forced colour scheme, so it
 * wears the style picked below in its own light or dark.
 */
function MiniApp({ scheme }: { scheme: "light" | "dark" }) {
  return (
    <div style={{ colorScheme: scheme }} className="absolute inset-0 flex gap-1.5 bg-sidebar p-1.5 pl-0">
      <div className="flex w-[30%] flex-col gap-1 pt-2 pl-1.5">
        <span className="flex gap-0.5 pb-1">
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span key={c} className="size-1 rounded-full" style={{ background: c }} />
          ))}
        </span>
        <span className="h-2.5 rounded-[3px] bg-selected" />
        <span className="mx-1 h-1 w-3/4 rounded-full bg-text/15" />
        <span className="mx-1 h-1 w-1/2 rounded-full bg-text/15" />
        <span className="mx-1 h-1 w-2/3 rounded-full bg-text/15" />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-1 rounded-[5px] bg-canvas p-1.5 shadow-[0_0_0_0.5px_var(--color-hairline),0_2px_6px_-2px_oklch(0%_0_0/0.15)]">
        <span className="ml-auto h-2 w-1/2 rounded-[3px] bg-fill" />
        <span className="h-1 w-5/6 rounded-full bg-text/25" />
        <span className="h-1 w-2/3 rounded-full bg-text/25" />
        <span className="mt-1 flex h-3 items-center justify-end rounded-[3px] bg-card px-0.5">
          <span className="h-2 w-2 rounded-[2px] bg-accent" />
        </span>
      </div>
    </div>
  );
}

/** A choice drawn as a picture over its name; picked, it wears the accent. */
function PickCard({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`flex flex-col gap-2 rounded-[14px] p-1.5 pb-2 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 ${
        on
          ? "bg-accent/10 shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-accent)_55%,transparent)]"
          : "bg-card hover:bg-hover"
      }`}
    >
      {children}
      <span className="flex items-center gap-2 px-1">
        <Radio on={on} />
        <span className={on ? "font-medium" : ""}>{label}</span>
      </span>
    </button>
  );
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      className={`grid size-4 shrink-0 place-items-center rounded-full transition-colors ${
        on ? "bg-accent text-inverse" : "ring-1 ring-border-strong"
      }`}
    >
      {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
    </span>
  );
}

/* ── Style: one shape, three colourways ─────────────────────────────── */

const STYLES: { id: Exclude<Direction, "off">; name: string; line: string; light: string; dark: string }[] = [
  { id: "a", name: "Ink", line: "Monochrome", light: "oklch(22% 0.005 285)", dark: "oklch(94% 0 0)" },
  { id: "b", name: "Crew", line: "Teal", light: "oklch(50% 0.1 200)", dark: "oklch(80% 0.11 188)" },
  { id: "c", name: "Cobalt", line: "Blue", light: "oklch(57% 0.2 258)", dark: "oklch(68% 0.17 255)" },
];

function StylePicker() {
  const { direction } = useProto();
  return (
    <section className="flex flex-col gap-2" data-setting="style">
      <Heading title="Style" description="Accent and greys." />
      <div role="radiogroup" aria-label="Style" className="grid grid-cols-3 gap-3">
        {STYLES.map((s) => {
          const on = direction === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => applyDirection(s.id)}
              className={`flex items-center gap-3 rounded-[14px] p-2.5 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 ${
                on
                  ? "bg-accent/10 shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-accent)_55%,transparent)]"
                  : "bg-card hover:bg-hover"
              }`}
            >
              <Swatch light={s.light} dark={s.dark} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{s.name}</span>
                <span className="truncate text-[12px] text-text-muted">{s.line}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The accent in both themes, split on the diagonal. */
function Swatch({ light, dark }: { light: string; dark: string }) {
  const style: CSSProperties = {
    borderRadius: 8,
    background: `linear-gradient(135deg, ${light} 0 50%, ${dark} 50% 100%)`,
  };
  return <span aria-hidden className="size-9 shrink-0 shadow-[inset_0_0_0_1px_var(--color-border)]" style={style} />;
}

/* ── Reading ────────────────────────────────────────────────────────── */

function SizeSlider({ value, onChange }: { value: Size; onChange: (size: Size) => void }) {
  const at = SIZES.indexOf(value);
  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] text-text-muted" aria-hidden>
        A
      </span>
      <div role="radiogroup" aria-label="Chat text size" className="relative flex h-6 w-40 items-center">
        <span className="absolute inset-x-2 h-1 rounded-full bg-selected" />
        <span
          className="absolute left-2 h-1 rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none"
          style={{ width: `calc((100% - 16px) * ${at / (SIZES.length - 1)})` }}
        />
        <span className="relative flex w-full justify-between">
          {SIZES.map((size, i) => (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={size === value}
              aria-label={`${size} px`}
              onClick={() => onChange(size)}
              className="grid size-4 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
            >
              {size === value ? (
                <span className="size-4 rounded-full bg-canvas shadow-[0_0_0_1.5px_var(--color-accent),0_1px_3px_oklch(0%_0_0/0.2)]" />
              ) : (
                <span className={`size-1.5 rounded-full ${i < at ? "bg-inverse/80" : "bg-text-muted/50"}`} />
              )}
            </button>
          ))}
        </span>
      </div>
      <span className="text-[16px] leading-none text-text-muted" aria-hidden>
        A
      </span>
      <span className="w-10 text-right text-[12px] text-text-muted tabular-nums">{value} px</span>
    </div>
  );
}

/* ── Bots ───────────────────────────────────────────────────────────── */

const FACES = ["crew", "scout", "atlas"];

function AvatarPicker() {
  const { avatar, update } = useBotAvatar();
  return (
    <section className="flex flex-col gap-2" data-setting="avatar">
      <Heading title="Bot faces" />
      <div role="radiogroup" aria-label="Avatar style" className="grid grid-cols-3 gap-3">
        {BOT_AVATARS.map((style) => (
          <PickCard key={style.id} on={avatar === style.id} onClick={() => update(style.id)} label={style.label}>
            <span className="flex h-12 items-center justify-center gap-1.5 rounded-[8px] bg-canvas/60">
              {FACES.map((seed) => (
                <BotAvatar key={seed} seed={seed} style={style.id} bare className="size-8" />
              ))}
            </span>
          </PickCard>
        ))}
      </div>
    </section>
  );
}

/* ── Preview ────────────────────────────────────────────────────────── */

function Preview({ density, size, still }: { density: Density; size: Size; still: boolean }) {
  const row = density === "compact" ? "h-7" : "h-8";
  return (
    <figure className={`${RAISED} flex flex-col gap-2 rounded-[20px] p-2`}>
      <figcaption className="flex items-center justify-between px-2 pt-1 text-[11px] text-text-muted">
        <span>Preview</span>
        <span>Live</span>
      </figcaption>
      <div className="flex h-[210px] overflow-hidden rounded-xl bg-sidebar @[900px]:h-[300px]">
        <div className={`flex w-[104px] shrink-0 flex-col p-1.5 ${density === "compact" ? "gap-0" : "gap-0.5"}`}>
          <p className="px-1.5 pt-1 pb-1 text-[10px] text-text-muted">Sessions</p>
          {[
            { seed: "atlas", name: "Atlas", on: true, dot: "working" },
            { seed: "scout", name: "Scout", on: false, dot: "wants" },
            { seed: "crew", name: "Pilot", on: false, dot: "" },
          ].map((s) => (
            <span
              key={s.seed}
              className={`flex ${row} items-center gap-1.5 rounded-chrome px-1.5 text-[12px] ${s.on ? "bg-selected font-medium" : ""}`}
            >
              <BotAvatar seed={s.seed} className="size-4" animated={s.dot === "working" && !still} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.dot === "wants" && <span className="size-1.5 rounded-full bg-warning" />}
              {s.dot === "working" && (
                <span
                  className={`size-2 rounded-full border-[1.5px] border-accent/25 border-t-accent ${still ? "" : "animate-spin"}`}
                />
              )}
            </span>
          ))}
        </div>
        <div className="my-1.5 mr-1.5 flex min-w-0 flex-1 flex-col gap-3 rounded-lg bg-canvas p-3 shadow-[0_0_0_1px_var(--color-hairline)]">
          <div className="-mx-3 -mt-3 flex h-8 items-center gap-1.5 border-b border-hairline px-3 text-[11px]">
            <span className="font-medium">Atlas</span>
            <span className="truncate text-text-muted">empty-state</span>
          </div>
          <span className="flex-1" />
          <p
            className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-fill px-2.5 py-1.5 leading-snug"
            style={{ fontSize: size }}
          >
            Make the empty state friendlier
          </p>
          <div className="flex items-start gap-2">
            <BotAvatar seed="atlas" className="size-5" animated={!still} />
            <p className="min-w-0 flex-1 leading-snug" style={{ fontSize: size }}>
              Done. The list now says what to do next, with a button to start.
            </p>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-card py-1 pr-1 pl-2.5">
            <span className="text-[11px] text-placeholder">Reply to Atlas</span>
            <span className="grid size-5 place-items-center rounded-md bg-accent text-inverse">
              <ArrowUpIcon className="size-3" strokeWidth={3} />
            </span>
          </div>
        </div>
      </div>
    </figure>
  );
}
