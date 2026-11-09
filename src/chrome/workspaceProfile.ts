// What a workspace's profile adds once the daemon keeps it: an icon of its own (found in its repo or uploaded) and
// the instructions and rules its agents read. Until then there is none: the tile shows the initials, and the
// settings page has neither section nor an icon to change.
import type { ComponentType } from "react";
import type { Session, Workspace } from "../lib/types";

/** The workspace's icon, or null for its initials. */
export function useWorkspaceFace(_workspace: Workspace): string | null {
  return null;
}

/** Looks for the workspaces' icons, and again for the one on screen now and then. */
export function useWorkspaceFaces(_workspaces: Workspace[], _active: Workspace | undefined): void {}

/** Changes the icon, heading the settings page; null: the tile, as it is. */
export const WorkspaceIconEditor: ComponentType<{ workspace: Workspace }> | null = null;

/** The instructions and the rules, over the page's General; null: none. */
export const WorkspaceProfileSections: ComponentType<{ workspace: Workspace; sessions: Session[] }> | null = null;
