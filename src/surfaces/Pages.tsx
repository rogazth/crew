import type { ReactNode } from "react";
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
  onOpenTerminal: (envId: string, input?: string) => Promise<void>;
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
  // The page is a sheet laid over the chrome, like the workspace under the tabs.
  const sheet = (children: ReactNode) => (
    <div data-sheet="page" className="h-full">
      {children}
    </div>
  );
  if (page.kind === "settings") {
    return sheet(
      <SettingsView
        section={page.section}
        workspaces={workspaces}
        onOpenTerminal={onOpenTerminal}
      />,
    );
  }
  if (page.kind === "routines" && activeWorkspace) {
    return sheet(
      <RoutinesView
        // A draft arriving from the bot drawer has to reopen the editor even
        // when the page is already up.
        key={page.draft?.key ?? "routines"}
        draft={page.draft}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspace.id}
        bots={bots}
        onConfirm={onConfirm}
      />,
    );
  }
  return null;
}
