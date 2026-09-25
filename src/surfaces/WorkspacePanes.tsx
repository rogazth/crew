import { useMemo } from 'react';
import { Agents } from './Agents';
import { Browsers } from './Browsers';
import { DiffsPool } from './DiffsPool';
import { ChatContext, type ChatActions } from './chat/context';
import { Surface } from './Surface';
import { Terminals } from './Terminals';
import type { ProviderId } from '../lib/providers';
import type { Pane } from '../lib/tabs';
import type { ProjectFile, Session, SessionStatus, Tab, Workspace } from '../lib/types';
import { parseContext } from '../lib/worktrees';

/**
 * A pane with where it runs resolved to a directory: its session's worktree,
 * else the worktree its strip belongs to, else the workspace folder.
 */
export type MountedPane = Pane & { cwd: string };

type Props = {
  tab: Tab | null;
  panes: Pane[];
  workspaces: Workspace[];
  sessions: Session[];
  cwd: string | null;
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
  onStatus: (id: string, status: SessionStatus) => void;
  onModel: (session: Session, provider: ProviderId, model: string) => void;
  onOpenFile: (file: ProjectFile) => void;
  onOpenSession: (sessionId: string) => void;
  onPatchBrowser: (workspaceId: string, tabId: string, patch: { url?: string; title?: string }) => void;
  onOpenBrowserTab: (workspaceId: string, tab: Tab, opts: { after: string; background: boolean }) => void;
  files: ProjectFile[];
};

/** Active surface plus the mounted agent, terminal and page overlays, of every workspace. */
export function WorkspacePanes({
  tab,
  panes,
  workspaces,
  sessions,
  cwd,
  hasWorkspace,
  onCreateWorkspace,
  onStatus,
  onModel,
  onOpenFile,
  onOpenSession,
  onPatchBrowser,
  onOpenBrowserTab,
  files,
}: Props) {
  // Keyed on where each session runs, not on the sessions: a status change
  // must not hand every mounted pane a fresh object.
  const placement = sessions.map((s) => `${s.id}\t${s.worktree ?? ''}`).join('\n');
  const mounted = useMemo(() => {
    const where = new Map(placement.split('\n').map((line) => line.split('\t') as [string, string]));
    return panes.flatMap((pane) => {
      const context = parseContext(pane.workspaceId);
      const workspace = workspaces.find((w) => w.id === context.workspaceId);
      if (!workspace) return [];
      const tab = pane.tab;
      const worktree = tab.kind === 'session' ? where.get(tab.sessionId) : undefined;
      const cwd = worktree || (tab.kind === 'session' ? workspace.path : (context.worktree ?? workspace.path));
      return [{ ...pane, cwd }];
    });
  }, [panes, placement, workspaces]);

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
    <div className="relative min-h-0 flex-1">
      <DiffsPool>
        <Surface
          tab={tab}
          sessions={sessions}
          hasWorkspace={hasWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          files={files}
          onOpenPath={chat.openPath}
        />
      </DiffsPool>
      <Terminals
        panes={mounted}
        sessions={sessions}
        onStatus={onStatus}
        onOpenFile={onOpenFile}
      />
      <Browsers panes={mounted} onPatch={onPatchBrowser} onOpenTab={onOpenBrowserTab} />
      <ChatContext value={chat}>
        <Agents panes={mounted} sessions={sessions} onModel={onModel} />
      </ChatContext>
    </div>
  );
}
