// What a workspace has besides its bots and sessions, under its name in the sidebar: its Services, its Routines and
// its Settings, each filling the main panel when picked. What is the app's (Connectors, Usage, Providers) lives in
// the app's Settings instead, reached from the rail's gear.
import { LayersIcon, SlidersHorizontalIcon, type LucideIcon as Icon } from "lucide-react";
import { RoutinesIcon } from "./RoutinesIcon";

/** The place the main panel shows; `tabs` for none, the sessions' tabs on screen. */
export type NavPlace = "tabs" | "services" | "routines" | "customize";

export type WorkspacePlacesProps = {
  current: NavPlace;
  /** Services with a run up, as the Services page counts them: one running in two worktrees is one. */
  running: number;
  onPick: (place: NavPlace) => void;
};

const PLACES: { place: Exclude<NavPlace, "tabs">; label: string; icon: Icon }[] = [
  { place: "services", label: "Services", icon: LayersIcon },
  { place: "routines", label: "Routines", icon: RoutinesIcon },
  { place: "customize", label: "Settings", icon: SlidersHorizontalIcon },
];

/**
 * One row each, as the sessions' rows are; the one on screen selected, the running services counted in brackets as
 * the pages count their filters. No rule under them: the gap that parts Bots from Sessions parts these from Bots.
 */
export function WorkspacePlaces({ current, running, onPick }: WorkspacePlacesProps) {
  return (
    <nav aria-label="Workspace" className="flex flex-col gap-0.5 px-2 pb-3">
      {PLACES.map(({ place, label, icon: Glyph }) => {
        const on = place === current;
        return (
          <button
            key={place}
            type="button"
            data-nav
            aria-current={on ? "page" : undefined}
            onClick={() => onPick(place)}
            className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left outline-none transition-colors duration-150 ease-out ${
              on ? "bg-selected font-medium" : "hover:bg-hover focus-visible:bg-hover"
            }`}
          >
            <Glyph aria-hidden className={`size-4 shrink-0 ${on ? "text-text" : "text-icon"}`} />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="truncate">{label}</span>
              {place === "services" && running > 0 && <span className="shrink-0 text-[12px] font-normal text-text-muted tabular-nums">({running})</span>}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
