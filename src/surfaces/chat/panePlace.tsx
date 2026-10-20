// The worktree the session on screen belongs to. A session nobody has written
// to yet can still move: its first screen shows the worktree as a fact that
// opens a list of worktrees, and picking one starts it there instead. A bot, a
// page or a tab with no place says nothing.
import { Menu } from "@base-ui/react/menu";
import { CheckIcon, ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { createContext, useContext } from "react";
import { PANEL, ROW } from "../../chrome/kit";

export type Place = { path: string; label: string };

/**
 * The session on screen, when it has not been written to: where it starts, the
 * worktrees it could start in, and what picking one does. Only that session's
 * first screen reads it; the chats behind other tabs are mounted too.
 */
export const PanePlaceContext = createContext<{ sessionId: string; place: Place; places: Place[]; onMove: (path: string) => void } | null>(null);

export const usePanePlace = (sessionId: string) => {
  const pick = useContext(PanePlaceContext);
  return pick?.sessionId === sessionId ? pick : null;
};

/** The worktree as a fact on a new session's first screen, opening the list of worktrees it can start in. */
export function WorktreeFact({ place, places, onMove }: { place: Place; places: Place[]; onMove: (path: string) => void }) {
  if (places.length < 2)
    return (
      <span className="ds-fact" title="The only worktree">
        {mark()}
        <span>{place.label}</span>
      </span>
    );
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger className="ds-fact ds-fact-button" title="Start this session in another worktree">
        {mark()}
        <span>{place.label}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="center" sideOffset={6} className="z-50">
          <Menu.Popup className={`${PANEL} min-w-56`}>
            <div className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">Start this session in</div>
            {places.map((item) => (
              <Menu.Item key={item.path} className={ROW} onClick={() => item.path !== place.path && onMove(item.path)}>
                {mark()}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <CheckIcon className={`size-4 shrink-0 ${item.path === place.path ? "" : "invisible"}`} />
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// The worktree icon the tab bar uses.
const mark = () => <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-icon" />;
