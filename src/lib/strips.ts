import { CLOSED_LIMIT, recentIds, withRecent, type TabState } from "./tabs";
import type { Session, Tab, Workspace, Worktree } from "./types";
import { sessionPath } from "./worktrees";

/** Each tab once, at its first place. */
function once(tabs: Tab[]): Tab[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => !seen.has(tab.id) && seen.add(tab.id));
}

/**
 * Per worktree to all together: the strips become one, main's first, then each
 * worktree's in the order git lists them, each keeping its own order. The tab
 * on screen stays on screen, and the most recent: the strips' recent orders
 * follow it one after another.
 */
export function joinStrips(strips: TabState[], onScreen: string | null): TabState {
  const tabs = once(strips.flatMap((strip) => strip.tabs));
  const open = new Set(tabs.map((tab) => tab.id));
  const closed = once(strips.flatMap((strip) => strip.closed))
    .filter((tab) => !open.has(tab.id))
    .slice(0, CLOSED_LIMIT);
  const activeId = open.has(onScreen ?? "") ? onScreen : (strips.find((strip) => strip.activeId)?.activeId ?? null);
  const recent = [...new Set(strips.flatMap(recentIds))];
  return withRecent({ tabs, activeId, closed, recent });
}

/**
 * All together back to per worktree: each tab goes to the strip of the worktree
 * `placeOf` names, one that has no worktree to the one `current`. Every listed
 * worktree gets a strip, in the joined strip's order, and the recent order of
 * its own tabs; the tab on screen stays the active one of its strip, the others
 * show the one last used, else their last. The reopen stack stays with `current`.
 */
export function splitStrip(
  strip: TabState,
  paths: string[],
  current: string,
  placeOf: (tab: Tab) => string | null,
): Map<string, TabState> {
  const out = new Map(paths.map((path) => [path, [] as Tab[]]));
  for (const tab of strip.tabs) {
    const place = placeOf(tab);
    (out.get(place ?? current) ?? out.get(current))?.push(tab);
  }
  const recent = recentIds(strip);
  return new Map(
    [...out].map(([path, tabs]) => {
      const own = new Set(tabs.map((tab) => tab.id));
      const mine = recent.filter((id) => own.has(id));
      const activeId = mine[0] ?? tabs.at(-1)?.id ?? null;
      return [path, { tabs, activeId, closed: path === current ? strip.closed : [], recent: mine }];
    }),
  );
}

/**
 * The worktree a tab belongs to, when it has one: a session's is where it
 * runs, a file's is the worktree whose folder holds it, else the main
 * checkout. Pages and the rest belong to none.
 */
export function tabPlace(tab: Tab, workspace: Workspace, worktrees: Worktree[], sessions: Session[]): string | null {
  if (tab.kind === "session") {
    const session = sessions.find((s) => s.id === tab.sessionId);
    return session ? sessionPath(session, workspace, worktrees) : null;
  }
  if (tab.kind !== "file") return null;
  // The deepest folder wins: a worktree can sit inside the main checkout.
  const holders = worktrees.filter((tree) => tab.path.startsWith(`${tree.path}/`));
  return holders.reduce<string | null>((deepest, tree) => (tree.path.length > (deepest?.length ?? 0) ? tree.path : deepest), null) ?? workspace.path;
}
