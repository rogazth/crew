import type { Confirm } from "../chrome/ConfirmDialog";
import type { RoutineDraft } from "../lib/routines";
import type { SettingsSectionId } from "../lib/settings";
import type { Session, Workspace } from "../lib/types";
import type { Processes } from "../hooks/useProcesses";
import type { Process } from "../lib/processes";
import { CommandsView, type Place } from "./CommandsView";
import { RoutinesView } from "./RoutinesView";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";

/** A page covers the workspace instead of living in a tab. */
export type Page =
  | { kind: "workspace" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines"; draft: RoutineDraft | null }
  | { kind: "search" }
  /** The active workspace's commands, and where each runs. */
  | { kind: "commands" };

type Props = {
  page: Page;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  sessions: Session[];
  onConfirm: (confirm: Confirm) => void;
  onOpenHit: (sessionId: string, pos: number) => void;
  onOpenTerminal: (envId: string) => Promise<void>;
  processes: Processes;
  /** The active workspace's worktrees, for where a command runs. */
  places: Place[];
  onOpenRun: (process: Process, worktree: string | null) => void;
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
  places,
  onOpenRun,
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
  if (page.kind === "commands" && activeWorkspace) {
    return (
      <CommandsView
        key={activeWorkspace.id}
        workspaceId={activeWorkspace.id}
        processes={processes}
        places={places}
        sessions={allSessions}
        onOpenRun={onOpenRun}
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
