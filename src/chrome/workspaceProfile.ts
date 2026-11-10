// A workspace's icon of its own: the best image its repo offers, another of its images or one the user uploaded, or
// none for its initials, as the daemon that holds the workspace keeps it (lib/workspaceIcons.ts). The rail asks for
// every workspace's, and again for the one in front once it has stayed there a beat and when the window comes back;
// the daemon looks in the repo again only once what it found is old. The picker is WorkspaceIcon.tsx; the
// instructions and rules are WorkspaceProfileSections.tsx.
import { useEffect, useSyncExternalStore } from "react";
import { SETTLE, imageOf, refresh, snapshot, subscribe } from "../lib/workspaceIcons";
import type { Workspace } from "../lib/types";

/** The workspace's icon, or null for its initials. */
export function useWorkspaceFace(workspace: Workspace): string | null {
  useSyncExternalStore(subscribe, snapshot);
  return imageOf(workspace.id);
}

/** Asks for the workspaces' icons, and again for the one on screen now and then. Home wears Crew's mark. */
export function useWorkspaceFaces(workspaces: Workspace[], active: Workspace | undefined): void {
  // By ids: a fresh list on each render would ask again on each render.
  const ids = workspaces
    .filter((workspace) => !workspace.home)
    .map((workspace) => workspace.id)
    .join("\n");
  useEffect(() => {
    for (const id of ids.split("\n")) if (id) void refresh(id);
  }, [ids]);

  const id = active && !active.home ? active.id : undefined;
  useEffect(() => {
    if (id === undefined) return;
    let timer: number | undefined;
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(id), SETTLE);
    };
    settle();
    window.addEventListener("focus", settle);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", settle);
    };
  }, [id]);
}
