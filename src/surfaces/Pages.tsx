import type { Confirm } from "../chrome/ConfirmDialog";
import type { RoutineDraft } from "../lib/routines";
import type { SettingsSectionId } from "../lib/settings";
import type { Session, Workspace } from "../lib/types";
import { RoutinesView } from "./RoutinesView";
import { SettingsView } from "./SettingsView";

/** A page covers the workspace instead of living in a tab. */
export type Page =
  | { kind: "workspace" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines"; draft: RoutineDraft | null };

type Props = {
  page: Page;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  sessions: Session[];
  onConfirm: (confirm: Confirm) => void;
  onOpenTerminal: (envId: string) => Promise<void>;
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
  onOpenTerminal,
}: Props) {
  const bots = sessions.filter((session) => session.kind === "bot");
  if (page.kind === "settings") {
    return (
      <SettingsView
        section={page.section}
        workspaces={workspaces}
        onConfirm={onConfirm}
        onOpenTerminal={onOpenTerminal}
      />
    );
  }
  if (page.kind === "routines" && activeWorkspace) {
    return (
      <RoutinesView
        // A draft arriving from the bot drawer has to reopen the editor even
        // when the page is already up.
        key={page.draft?.key ?? "routines"}
        draft={page.draft}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspace.id}
        bots={bots}
        onConfirm={onConfirm}
      />
    );
  }
  return null;
}
