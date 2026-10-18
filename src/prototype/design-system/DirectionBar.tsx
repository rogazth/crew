// PROTOTYPE — throwaway. The dev bar over the real app and the gallery: the
// visual direction, the theme, and a simulated app update. Visually apart from
// the app on purpose, so it never reads as part of the design.
import { ArrowDownToLineIcon, ChevronLeftIcon, ChevronRightIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useEffect } from "react";
import { applyDirection, DIRECTIONS, setTheme, setUpdate, useProto, type Theme, type UpdatePhase } from "./direction";

const THEMES: { key: Theme; icon: typeof SunIcon; label: string }[] = [
  { key: "system", icon: MonitorIcon, label: "System" },
  { key: "light", icon: SunIcon, label: "Light" },
  { key: "dark", icon: MoonIcon, label: "Dark" },
];

const NEXT_UPDATE: Record<UpdatePhase, UpdatePhase> = {
  none: "available",
  available: "downloading",
  downloading: "ready",
  ready: "none",
};

const UPDATE_LABEL: Record<UpdatePhase, string> = {
  none: "No update",
  available: "Available",
  downloading: "Downloading",
  ready: "Ready",
};

export function DirectionBar({ keys = false }: { keys?: boolean }) {
  const proto = useProto();
  const index = Math.max(
    0,
    DIRECTIONS.findIndex((d) => d.key === proto.direction),
  );
  const step = (by: number) => applyDirection(DIRECTIONS[(index + by + DIRECTIONS.length) % DIRECTIONS.length]!.key);

  useEffect(() => {
    if (!keys) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!import.meta.env.DEV) return null;
  const current = DIRECTIONS[index]!;
  return (
    <div
      style={{ colorScheme: "dark" }}
      className="fixed right-3 bottom-3 z-[100] flex items-center gap-1 rounded-full bg-[#111] px-1.5 py-1 text-[12px] text-white shadow-xl ring-1 ring-white/10"
    >
      <button type="button" onClick={() => step(-1)} className="grid size-7 place-items-center rounded-full hover:bg-white/10" aria-label="Previous direction">
        <ChevronLeftIcon className="size-4" />
      </button>
      <span className="w-24 text-center tabular-nums">
        {`${current.key.toUpperCase()} · ${current.name}`}
      </span>
      <button type="button" onClick={() => step(1)} className="grid size-7 place-items-center rounded-full hover:bg-white/10" aria-label="Next direction">
        <ChevronRightIcon className="size-4" />
      </button>
      <span className="mx-1 h-4 w-px bg-white/15" />
      {THEMES.map(({ key, icon: Glyph, label }) => (
        <button
          key={key}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={proto.theme === key}
          onClick={() => setTheme(key)}
          className={`grid size-7 place-items-center rounded-full ${proto.theme === key ? "bg-white/20" : "text-white/60 hover:bg-white/10"}`}
        >
          <Glyph className="size-3.5" />
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-white/15" />
      <button
        type="button"
        title="Simulate an app update: click to step it"
        onClick={() => setUpdate(NEXT_UPDATE[proto.update])}
        className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 ${proto.update === "none" ? "text-white/60 hover:bg-white/10" : "bg-white/20"}`}
      >
        <ArrowDownToLineIcon className="size-3.5" />
        <span className="tabular-nums">
          {proto.update === "downloading" ? `${Math.round(proto.progress * 100)}%` : UPDATE_LABEL[proto.update]}
        </span>
      </button>
    </div>
  );
}
