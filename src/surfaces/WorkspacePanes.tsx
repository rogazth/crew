import { useMemo, type ReactNode } from 'react';
import { Agents } from './Agents';
import { Browsers } from './Browsers';
import { DiffsPool } from './DiffsPool';
import { Previews } from './Previews';
import { ChatContext, type ChatActions } from './chat/context';
import { Surface, type ProcessTabOf } from './Surface';
import { Terminals } from './Terminals';
import type { Confirm } from '../chrome/ConfirmDialog';
import type { BrowserTabPatch, Pane } from '../lib/tabs';
import type { ProjectFile, Session, SessionStatus, Tab, Workspace } from '../lib/types';
import { parseContext } from '../lib/worktrees';

/**
 * A pane with where it runs resolved to a directory: where its session runs,
 * else the worktree its strip belongs to, else the workspace folder.
 */
export type MountedPane = Pane & { cwd: string };

type Props = {
  tab: Tab | null;
  panes: Pane[];
  workspaces: Workspace[];
  sessions: Session[];
  /** Where a worktree's work runs: there while git lists it, else the workspace folder. */
  placeOf: (worktree: string | null, workspace: Workspace) => string;
  cwd: string | null;
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
  onStatus: (id: string, status: SessionStatus) => void;
  onOpenFile: (file: ProjectFile) => void;
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
};

/** Active surface plus the mounted agent, terminal, page and media overlays, of every workspace. */
export function WorkspacePanes({
  tab,
  panes,
  workspaces,
  sessions,
  placeOf,
  cwd,
  hasWorkspace,
  onCreateWorkspace,
  onStatus,
  onOpenFile,
  onOpenSession,
  onPatchBrowser,
  onOpenBrowserTab,
  onAdoptBrowserTab,
  files,
  onOpenHistory,
  onConfirm,
  renderProcess,
  renderCommands,
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
      const context = parseContext(pane.workspaceId);
      const workspace = workspaces.find((w) => w.id === context.workspaceId);
      if (!workspace) return [];
      const tab = pane.tab;
      const cwd =
        tab.kind === 'session'
          ? (where.get(tab.sessionId) ?? workspace.path)
          : tab.kind === 'stub' && tab.worktree !== undefined
            ? placeOf(tab.worktree, workspace)
            : placeOf(context.worktree, workspace);
      return [{ ...pane, cwd }];
    });
  }, [panes, placement, placeOf, workspaces]);

  // Bound to the workspace on screen, which is the only one a click can come
  // from: the panes behind it are hidden, so nothing there can reach these.
  const chat = useMemo<ChatActions>(
    () => ({
      openPath: (path) => {
        if (!cwd) return;
        const absolute = path.startsWith('/') ? path : `${cwd}/${path.replace(/^\.\//, '')}`;
        const relative = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute;
        onOpenFile({ path: absolute, relative, name: relative.split('/').pop() ?? relative });
      },
      openSession: onOpenSession,
      files,
    }),
    [cwd, onOpenFile, onOpenSession, files],
  );
  return (
    // Its own stacking context: a page an agent drives out of sight sits beneath every pane here, and nothing else.
    <div className="relative isolate min-h-0 flex-1">
      <DiffsPool>
        <Surface
          tab={tab}
          sessions={sessions}
          hasWorkspace={hasWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          files={files}
          onOpenPath={chat.openPath}
          onOpenHistory={onOpenHistory}
          onConfirm={onConfirm}
          renderProcess={renderProcess}
          renderCommands={renderCommands}
        />
      </DiffsPool>
      <ChatContext value={chat}>
        {/* A session's chat is drawn inside its terminal's pane. */}
        <Terminals
          panes={mounted}
          sessions={sessions}
          onStatus={onStatus}
          onOpenFile={onOpenFile}
        />
      </ChatContext>
      <Browsers panes={mounted} onPatch={onPatchBrowser} onOpenTab={onOpenBrowserTab} onAdopt={onAdoptBrowserTab} />
      <Previews panes={mounted} />
      <ChatContext value={chat}>
        <Agents panes={mounted} sessions={sessions} />
      </ChatContext>
    </div>
  );
}
