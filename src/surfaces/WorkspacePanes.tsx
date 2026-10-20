import { useMemo, type ReactNode } from 'react';
import { TurnChats } from './TurnChats';
import { Browsers } from './Browsers';
import { DiffsPool } from './DiffsPool';
import { ChatContext, type ChatActions } from './chat/context';
import { Surface, type ProcessTabOf } from './Surface';
import { Terminals } from './Terminals';
import type { Confirm } from '../chrome/ConfirmDialog';
import type { Process } from '../lib/processes';
import type { BrowserTabPatch, Pane } from '../lib/tabs';
import type { ProjectFile, Session, Tab, Workspace } from '../lib/types';
import { homeFor } from '../lib/client/registry';
import { homePath, resolvePath } from '../lib/terminalPaths';

/**
 * A pane with where it runs resolved to a directory: where its session runs,
 * else the workspace folder.
 */
export type MountedPane = Pane & { cwd: string };

type Props = {
  tab: Tab | null;
  /** What the pane shows with no tab open. */
  empty?: ReactNode;
  panes: Pane[];
  workspaces: Workspace[];
  sessions: Session[];
  /** Where a worktree's work runs: there while git lists it, else the workspace folder. */
  placeOf: (worktree: string | null, workspace: Workspace) => string;
  cwd: string | null;
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
  onOpenFile: (file: ProjectFile) => void;
  /** Shows an absolute folder in the explorer, opened. */
  onOpenFolder: (path: string) => void;
  /** An HTML or SVG file rendered in a page tab. */
  onOpenFileInBrowser: (file: { path: string; relative: string }) => void;
  onOpenSession: (sessionId: string) => void;
  onPatchBrowser: (workspaceId: string, tabId: string, patch: BrowserTabPatch) => void;
  onOpenBrowserTab: (workspaceId: string, tab: Tab, opts: { after: string; background: boolean }) => void;
  /** An agent needs this tab in that strip: add it behind the one on screen. */
  onAdoptBrowserTab: (context: string, tab: Tab) => void;
  files: ProjectFile[];
  onOpenHistory: (url: string) => void;
  onConfirm: (confirm: Confirm) => void;
  renderProcess: (tab: ProcessTabOf) => ReactNode;
  renderCommands: () => ReactNode;
  /** The workspace's commands: a chat lists the runs its session started. */
  processes: readonly Process[];
  onOpenProcessRun: (process: Process, worktree: string | null) => void;
  /** A session's MCP server login, run in a terminal tab. */
  onOpenSignIn: (sessionId: string, server: string, command: string[]) => void;
};

/** Active surface plus the mounted turn chat, terminal and page overlays, of every workspace. */
export function WorkspacePanes({
  tab,
  empty,
  panes,
  workspaces,
  sessions,
  placeOf,
  cwd,
  hasWorkspace,
  onCreateWorkspace,
  onOpenFile,
  onOpenFolder,
  onOpenFileInBrowser,
  onOpenSession,
  onPatchBrowser,
  onOpenBrowserTab,
  onAdoptBrowserTab,
  files,
  onOpenHistory,
  onConfirm,
  renderProcess,
  renderCommands,
  processes,
  onOpenProcessRun,
  onOpenSignIn,
}: Props) {
  // Keyed on where each session runs, not on the sessions: a status change
  // must not hand every mounted pane a fresh object.
  const placement = sessions
    .flatMap((s) => {
      const workspace = workspaces.find((w) => w.id === s.workspaceId);
      return workspace ? [`${s.id}\t${placeOf(s.worktree, workspace)}`] : [];
    })
    .join('\n');
  const mounted = useMemo(() => {
    const where = new Map(placement.split('\n').map((line) => line.split('\t') as [string, string]));
    return panes.flatMap((pane) => {
      const workspace = workspaces.find((w) => w.id === pane.workspaceId);
      if (!workspace) return [];
      const tab = pane.tab;
      const cwd =
        tab.kind === 'session'
          ? (where.get(tab.sessionId) ?? workspace.path)
          : tab.kind === 'stub' && tab.worktree !== undefined
            ? placeOf(tab.worktree, workspace)
            : placeOf(null, workspace);
      return [{ ...pane, cwd }];
    });
  }, [panes, placement, placeOf, workspaces]);

  // Bound to the workspace on screen, which is the only one a click can come
  // from: the panes behind it are hidden, so nothing there can reach these.
  const chat = useMemo<ChatActions>(
    () => ({
      openPath: (path) => {
        if (!cwd) return;
        // `~` is the home of the machine the chat runs on, which may not be this Mac.
        const absolute = resolvePath(path, cwd, homeFor(cwd) ?? homePath());
        const relative = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute;
        onOpenFile({ path: absolute, relative, name: relative.split('/').pop() ?? relative });
      },
      openFolder: (path) => {
        if (!cwd) return;
        onOpenFolder(resolvePath(path, cwd, homeFor(cwd) ?? homePath()).replace(/\/+$/, ''));
      },
      resolvePath: (path) => {
        if (!cwd) return null;
        const home = homeFor(cwd) ?? homePath();
        if (path.startsWith("~/") && !home) return null;
        return resolvePath(path, cwd, home);
      },
      openSession: onOpenSession,
      openAgent: onOpenSession,
      files,
      processes,
      openProcessRun: onOpenProcessRun,
      openSignIn: onOpenSignIn,
      confirm: onConfirm,
    }),
    [cwd, onOpenFile, onOpenFolder, onOpenSession, files, processes, onOpenProcessRun, onOpenSignIn, onConfirm],
  );
  return (
    // Its own stacking context: a page an agent drives out of sight sits beneath every pane here, and nothing else.
    <div className="relative isolate min-h-0 min-w-0 flex-1">
      <DiffsPool>
        <Surface
          tab={tab}
          empty={empty}
          sessions={sessions}
          hasWorkspace={hasWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          files={files}
          onOpenPath={chat.openPath}
          onOpenInBrowser={onOpenFileInBrowser}
          onOpenHistory={onOpenHistory}
          onConfirm={onConfirm}
          renderProcess={renderProcess}
          renderCommands={renderCommands}
        />
      </DiffsPool>
      <Terminals panes={mounted} onOpenFile={onOpenFile} />
      <Browsers panes={mounted} sessions={sessions} onPatch={onPatchBrowser} onOpenTab={onOpenBrowserTab} onAdopt={onAdoptBrowserTab} />
      <ChatContext value={chat}>
        <TurnChats panes={mounted} sessions={sessions} />
      </ChatContext>
    </div>
  );
}
