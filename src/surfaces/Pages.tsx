import type { Confirm } from "../chrome/ConfirmDialog";
import type { RoutineDraft } from "../lib/routines";
import type { SettingsSectionId } from "../lib/settings";
import type { Session, Workspace } from "../lib/types";
import { RoutinesView } from "./RoutinesView";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";

/** A page covers the workspace instead of living in a tab. */
export type Page =
  | { kind: "workspace" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines"; draft: RoutineDraft | null }
  | { kind: "search" };

type Props = {
  page: Page;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  sessions: Session[];
  onConfirm: (confirm: Confirm) => void;
  onOpenHit: (sessionId: string, pos: number) => void;
};

/**
 * Everything that is not the workspace itself. Kept out of `App` so adding a
 * page is a branch here rather than another fork in the shell.
 */
export function Pages({
  page,
  workspaces,
  activeWorkspace,
  sessions,
  onConfirm,
  onOpenHit,
}: Props) {
  const agents = sessions.filter((session) => session.kind === "agent");
  if (page.kind === "settings") return <SettingsView section={page.section} />;
  if (page.kind === "search") return <SearchView agents={agents} onOpenHit={onOpenHit} />;
  if (page.kind === "routines" && activeWorkspace) {
    return (
      <RoutinesView
        // A draft arriving from the agent drawer has to reopen the editor even
        // when the page is already up.
        key={page.draft?.key ?? "routines"}
        draft={page.draft}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspace.id}
        agents={agents}
        onConfirm={onConfirm}
      />
    );
  }
  return null;
}
