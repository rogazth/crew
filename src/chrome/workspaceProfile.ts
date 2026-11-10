// A workspace's icon of its own, found in its repo or uploaded, once the daemon keeps it. Until then there is none:
// the tile shows the initials, and the settings page has no icon to change. Its instructions and rules are real:
// WorkspaceProfileSections.tsx.
import type { ComponentType } from "react";
import type { Workspace } from "../lib/types";

/** The workspace's icon, or null for its initials. */
export function useWorkspaceFace(_workspace: Workspace): string | null {
  return null;
}

/** Looks for the workspaces' icons, and again for the one on screen now and then. */
export function useWorkspaceFaces(_workspaces: Workspace[], _active: Workspace | undefined): void {}

/** Changes the icon, heading the settings page; null: the tile, as it is. */
export const WorkspaceIconEditor: ComponentType<{ workspace: Workspace }> | null = null;
