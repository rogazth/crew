import type { Confirm } from "../chrome/ConfirmDialog";
import type { RoutineDraft } from "../lib/routines";
import type { SettingsSectionId } from "../lib/settings";
import type { Session, Workspace } from "../lib/types";
import type { Processes } from "../hooks/useProcesses";
import { ProcessView } from "./ProcessView";
import { RoutinesView } from "./RoutinesView";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";

/** A page covers the workspace instead of living in a tab. */
export type Page =
  | { kind: "workspace" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines"; draft: RoutineDraft | null }
  | { kind: "search" }
  /** One of the active workspace's commands and its output. */
  | { kind: "process"; processId: string };

type Props = {
  page: Page;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  sessions: Session[];
  onConfirm: (confirm: Confirm) => void;
  onOpenHit: (sessionId: string, pos: number) => void;
  onOpenTerminal: (envId: string) => Promise<void>;
  processes: Processes;
  /** Every workspace's, to name who wrote a command. */
  allSessions: Session[];
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
  onOpenTerminal,
  processes,
  allSessions,
}: Props) {
  const agents = sessions.filter((session) => session.kind === "agent");
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
  if (page.kind === "search") return <SearchView agents={agents} onOpenHit={onOpenHit} />;
  if (page.kind === "process") {
    return (
      <ProcessView
        key={page.processId}
        processId={page.processId}
        processes={processes}
        sessions={allSessions}
        onConfirm={onConfirm}
      />
    );
  }
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
