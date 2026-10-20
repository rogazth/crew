// Appearance: theme as three little windows, the style (the palette) as
// swatches, the chat text size and bot faces, with a live preview that wears
// every choice. Motion follows the OS (prefers-reduced-motion), so it has no control.
import { ArrowUpIcon, CheckIcon, MinusIcon, PlusIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { useBotAvatar } from "../../hooks/useBotAvatar";
import { useAccent } from "../../hooks/useAccent";
import { useChatText } from "../../hooks/useChatText";
import { useColorMode } from "../../hooks/useColorMode";
import { ACCENTS, type AccentId } from "../../lib/accent";
import { BOT_AVATARS } from "../../lib/botAvatar";
import { CHAT_TEXT_MAX, CHAT_TEXT_MIN, DEFAULT_CHAT_TEXT } from "../../lib/chatText";
import { COLOR_MODES } from "../../lib/colorMode";
import { Heading, RAISED, SettingsPage } from "./ui";

export function AppearancePage() {
  return (
    <SettingsPage title="Appearance" wide>
      <div className="grid grid-cols-1 items-start gap-8 @[900px]:grid-cols-[minmax(0,1fr)_288px]">
        <div className="order-2 flex min-w-0 flex-col gap-8 @[900px]:order-1">
          <ThemePicker />
          <StylePicker />
          <TextSize />
          <AvatarPicker />
        </div>
        <div className="order-1 @[900px]:sticky @[900px]:top-6 @[900px]:order-2">
          <Preview />
        </div>
      </div>
    </SettingsPage>
  );
}

/* ── Theme ──────────────────────────────────────────────────────────── */

function ThemePicker() {
  const color = useColorMode();
  return (
    <section className="flex flex-col gap-2" data-setting="theme">
      <Heading title="Theme" />
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
        {COLOR_MODES.map((t) => (
          <PickCard key={t.id} on={color.mode === t.id} onClick={() => color.update(t.id)} label={t.label}>
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
function PickCard({
  on,
  onClick,
  label,
  children,
}: {
  on: boolean;
  onClick: () => void;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`flex flex-col gap-2 rounded-[14px] p-1.5 pb-2 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 ${
        on
          ? "bg-card shadow-[inset_0_0_0_1.5px_var(--color-text)]"
          : "bg-card shadow-[0_0_0_1px_var(--color-hairline)] hover:bg-hover"
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
        on ? "bg-text text-inverse" : "ring-1 ring-border-strong"
      }`}
    >
      {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
    </span>
  );
}

/* ── Style: one shape, three colourways ─────────────────────────────── */

const STYLES: Record<AccentId, { line: string; light: string; dark: string }> = {
  ink: { line: "Monochrome", light: "oklch(22% 0.005 285)", dark: "oklch(94% 0 0)" },
  teal: { line: "Warm greys", light: "oklch(50% 0.1 200)", dark: "oklch(80% 0.11 188)" },
  cobalt: { line: "Blue", light: "oklch(57% 0.2 258)", dark: "oklch(68% 0.17 255)" },
};

function StylePicker() {
  const { accent, update } = useAccent();
  return (
    <section className="flex flex-col gap-2" data-setting="style">
      <Heading title="Style" description="Accent and greys." />
      <div role="radiogroup" aria-label="Style" className="grid grid-cols-3 gap-3">
        {ACCENTS.map((item) => {
          const s = STYLES[item.id];
          const on = accent === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => update(item.id)}
              className={`flex items-center gap-3 rounded-[14px] p-2.5 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 ${
                on
                  ? "bg-card shadow-[inset_0_0_0_1.5px_var(--color-text)]"
                  : "bg-card shadow-[0_0_0_1px_var(--color-hairline)] hover:bg-hover"
              }`}
            >
              <Swatch light={s.light} dark={s.dark} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{item.label}</span>
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

/* ── Chat text size ─────────────────────────────────────────────────── */

function TextSize() {
  const { size, update } = useChatText();
  const fill = ((size - CHAT_TEXT_MIN) / (CHAT_TEXT_MAX - CHAT_TEXT_MIN)) * 100;
  const step =
    "grid size-7 place-items-center rounded-lg text-text-muted outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 disabled:pointer-events-none disabled:opacity-40";
  return (
    <section className="flex flex-col gap-2" data-setting="text-size">
      <Heading title="Chat text size" description="The conversation and the composer." />
      <div className={`${RAISED} flex items-center gap-3 rounded-[14px] px-4 py-3`}>
        <span aria-hidden className="text-[11px] text-text-muted">
          A
        </span>
        <input
          type="range"
          aria-label="Chat text size"
          aria-valuetext={`${size} px`}
          min={CHAT_TEXT_MIN}
          max={CHAT_TEXT_MAX}
          step={1}
          value={size}
          onChange={(event) => update(Number(event.target.value))}
          style={{ "--fill": `${fill}%` } as CSSProperties}
          className="crew-range min-w-0 flex-1"
        />
        <span aria-hidden className="text-[18px] leading-none text-text-muted">
          A
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Smaller"
            disabled={size <= CHAT_TEXT_MIN}
            onClick={() => update(size - 1)}
            className={step}
          >
            <MinusIcon className="size-3.5" />
          </button>
          <span className="w-11 text-center text-[12px] text-text-muted tabular-nums">{size} px</span>
          <button
            type="button"
            aria-label="Larger"
            disabled={size >= CHAT_TEXT_MAX}
            onClick={() => update(size + 1)}
            className={step}
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => update(DEFAULT_CHAT_TEXT)}
          disabled={size === DEFAULT_CHAT_TEXT}
          className="rounded-lg px-2 py-1 text-[12px] text-text-muted outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 disabled:pointer-events-none disabled:opacity-40"
        >
          Reset
        </button>
      </div>
    </section>
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

/** The preview is a miniature of the app, so the chat text keeps its proportion rather than its px. */
const PREVIEW_SCALE = 0.8;

function Preview() {
  const { size } = useChatText();
  const chatText: CSSProperties = { fontSize: size * PREVIEW_SCALE };
  return (
    <figure className={`${RAISED} flex flex-col gap-2 rounded-[20px] p-2`}>
      <figcaption className="flex items-center justify-between px-2 pt-1 text-[11px] text-text-muted">
        <span>Preview</span>
        <span>Live</span>
      </figcaption>
      <div className="flex h-[210px] overflow-hidden rounded-xl bg-sidebar @[900px]:h-[300px]">
        <div className={`flex w-[104px] shrink-0 flex-col p-1.5 gap-0.5`}>
          <p className="px-1.5 pt-1 pb-1 text-[10px] text-text-muted">Sessions</p>
          {[
            { seed: "atlas", name: "Atlas", on: true, dot: "working" },
            { seed: "scout", name: "Scout", on: false, dot: "wants" },
            { seed: "crew", name: "Pilot", on: false, dot: "" },
          ].map((s) => (
            <span
              key={s.seed}
              className={`flex h-8 items-center gap-1.5 rounded-chrome px-1.5 text-[12px] ${s.on ? "bg-selected font-medium" : ""}`}
            >
              <BotAvatar seed={s.seed} className="size-4" animated={s.dot === "working"} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.dot === "wants" && <span className="size-1.5 rounded-full bg-warning" />}
              {s.dot === "working" && (
                <span className={`size-2 rounded-full border-[1.5px] border-accent/25 border-t-accent animate-spin`} />
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
            style={chatText}
          >
            Make the empty state friendlier
          </p>
          <div className="flex items-start gap-2">
            <BotAvatar seed="atlas" className="size-5" animated />
            <p className="min-w-0 flex-1 leading-snug" style={chatText}>
              Done. The list now says what to do next, with a button to start.
            </p>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-card py-1 pr-1 pl-2.5">
            <span className="text-placeholder" style={chatText}>
              Reply to Atlas
            </span>
            <span className="grid size-5 place-items-center rounded-md bg-accent text-inverse">
              <ArrowUpIcon className="size-3" strokeWidth={3} />
            </span>
          </div>
        </div>
      </div>
    </figure>
  );
}
