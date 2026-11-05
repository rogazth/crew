// General's looks: theme as three little windows, the chat text size and bot
// faces. Motion follows the OS (prefers-reduced-motion), so it has no control.
import { CheckIcon, MinusIcon, PlusIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { useBotAvatar } from "../../hooks/useBotAvatar";
import { useChatText } from "../../hooks/useChatText";
import { useColorMode } from "../../hooks/useColorMode";
import { BOT_AVATARS } from "../../lib/botAvatar";
import { CHAT_TEXT_MAX, CHAT_TEXT_MIN, DEFAULT_CHAT_TEXT } from "../../lib/chatText";
import { COLOR_MODES } from "../../lib/colorMode";
import { Heading } from "./ui";

export function AppearanceSections() {
  return (
    <>
      <ThemePicker />
      <TextSize />
      <AvatarPicker />
    </>
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
 * A tiny window drawn with the live tokens under a forced colour scheme, in its
 * own light or dark.
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
        on ? "bg-accent text-inverse" : "ring-1 ring-border-strong"
      }`}
    >
      {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
    </span>
  );
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
      <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3">
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
      <div role="radiogroup" aria-label="Avatar style" className="grid grid-cols-2 gap-3 @[620px]:grid-cols-4">
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
