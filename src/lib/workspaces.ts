import { fuzzyMatch } from "./fuzzy";
import { providerLine } from "./providers";
import type { Session, Workspace } from "./types";

/** Last path segment, so picking `/Users/me/code/furry` proposes "furry". */
export function nameFromPath(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "";
}

export function resolveActive(
  workspaces: Workspace[],
  activeId: string | null,
): Workspace | null {
  if (workspaces.length === 0) return null;
  return workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null;
}

/** Inline rail filter. Matches the name first, then the path. */
export function filterWorkspaces(
  workspaces: Workspace[],
  query: string,
): Workspace[] {
  if (!query.trim()) return workspaces;
  const scored: { workspace: Workspace; score: number }[] = [];
  for (const workspace of workspaces) {
    const byName = fuzzyMatch(query, workspace.name);
    const byPath = byName ? null : fuzzyMatch(query, workspace.path);
    const hit = byName ?? byPath;
    if (hit) {
      scored.push({ workspace, score: hit.score + (byName ? 100 : 0) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.workspace);
}

/** Inline sidebar filter. Matches the name first, then provider + model. */
export function filterSessions(sessions: Session[], query: string): Session[] {
  if (!query.trim()) return sessions;
  const scored: { session: Session; score: number }[] = [];
  for (const session of sessions) {
    const byName = fuzzyMatch(query, session.name);
    const byProvider = byName
      ? null
      : fuzzyMatch(query, providerLine(session.provider, session.model));
    const hit = byName ?? byProvider;
    if (hit) scored.push({ session, score: hit.score + (byName ? 100 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.session);
}


/** Sessions open without prompting, so the name is derived: claude, claude 2, … */
export function nextSessionName(sessions: Session[], base: string): string {
  const taken = new Set(
    sessions.filter((s) => s.kind === "terminal").map((s) => s.name),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The home prefix says nothing about the folder; `~` keeps the tail visible. */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** Up to two initials from the folder name: `storefront-api` → SA, `crew` → C. */
export function workspaceMark(name: string): string {
  const words = name.split(/[\s\-_.]+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0] ?? "");
  return initials.join("").toUpperCase() || "?";
}
