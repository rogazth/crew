// PROTOTYPE — the floating state bar, as the earlier prototypes' variant bar: every state one pick away.
import { ChevronLeftIcon, ChevronRightIcon, ListIcon, MoonIcon, SunIcon, SunMoonIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { proto, STATES, useProto } from "./store";

export function Switcher() {
  const { index, theme, world } = useProto();
  const [listOpen, setListOpen] = useState(false);
  const state = STATES[index]!;
  const queued = world.chats[world.active]?.queued.length ?? 0;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) return;
      if (!event.altKey) return;
      if (event.key === "ArrowLeft") proto.step(-1);
      if (event.key === "ArrowRight") proto.step(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const ThemeGlyph = theme === "system" ? SunMoonIcon : theme === "light" ? SunIcon : MoonIcon;

  return (
    <div className="fixed bottom-3 left-3 z-[100] flex w-[300px] flex-col items-start gap-2">
      {listOpen && (
        <div className="max-h-[60vh] w-[420px] overflow-y-auto rounded-2xl bg-surface p-1.5 text-[12.5px] shadow-float">
          {STATES.map((item, at) => {
            const header = STATES[at - 1]?.group !== item.group ? item.group : null;
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-text-muted">{header}</div>}
                <button
                  type="button"
                  onClick={() => {
                    proto.go(at);
                    setListOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${at === index ? "bg-selected" : "hover:bg-hover"}`}
                >
                  <span className="w-5 shrink-0 text-right text-[11px] text-text-muted tabular-nums">{at + 1}</span>
                  <span className="min-w-0 truncate">{item.title}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="w-full rounded-xl bg-surface/95 px-3 py-2 text-[12px] leading-4 text-text-muted shadow-float">
        <div className="mb-0.5 font-medium text-text">{state.title}</div>
        {state.note}
        {queued > 0 && (
          <button type="button" onClick={proto.takeQueued} className="mt-2 flex h-6 items-center rounded-md bg-card px-2 text-text ring-1 ring-hairline hover:bg-hover">
            Simulate: the CLI picks up {queued} queued
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 rounded-full bg-[#ff3d8b] p-1 text-[12px] font-medium text-white shadow-[0_8px_30px_rgba(255,61,139,0.45)]">
        <button type="button" aria-label="Previous state" onClick={() => proto.step(-1)} className="grid size-7 place-items-center rounded-full hover:bg-white/20">
          <ChevronLeftIcon className="size-4" />
        </button>
        <button type="button" onClick={() => setListOpen((open) => !open)} className="flex h-7 items-center gap-1.5 rounded-full px-2 tabular-nums hover:bg-white/20">
          <ListIcon className="size-3.5" />
          <b>
            {index + 1}/{STATES.length}
          </b>
          <span className="max-w-[110px] truncate opacity-80">{state.group}</span>
        </button>
        <button type="button" aria-label="Next state" onClick={() => proto.step(1)} className="grid size-7 place-items-center rounded-full hover:bg-white/20">
          <ChevronRightIcon className="size-4" />
        </button>
        <button
          type="button"
          title={`Theme: ${theme}`}
          aria-label={`Theme: ${theme}`}
          onClick={() => proto.theme(nextTheme)}
          className="ml-1 grid size-7 place-items-center rounded-full bg-white/15 hover:bg-white/25"
        >
          <ThemeGlyph className="size-3.5" />
        </button>
        <span className="px-1.5 text-[11px] opacity-70">⌥←→</span>
      </div>
    </div>
  );
}
