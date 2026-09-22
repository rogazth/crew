import { useMemo } from 'react';
import { Agents } from './Agents';
import { DiffsPool } from './DiffsPool';
import { ChatContext, type ChatActions } from './chat/context';
import { Surface } from './Surface';
import { Terminals } from './Terminals';
import type { ProviderId } from '../lib/providers';
import type { Pane } from '../lib/tabs';
import type { ProjectFile, Session, SessionStatus, Tab, Workspace } from '../lib/types';

/** A pane with the workspace it belongs to resolved to a directory. */
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
  files: ProjectFile[];
};

/** Active surface plus the mounted agent/terminal overlays, of every workspace. */
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
  files,
}: Props) {
  const mounted = useMemo(
    () =>
      panes.flatMap((pane) => {
        const workspace = workspaces.find((w) => w.id === pane.workspaceId);
        return workspace ? [{ ...pane, cwd: workspace.path }] : [];
      }),
    [panes, workspaces],
  );

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
        />
      </DiffsPool>
      <Terminals
        panes={mounted}
        sessions={sessions}
        onStatus={onStatus}
        onOpenFile={onOpenFile}
      />
      <ChatContext value={chat}>
        <Agents panes={mounted} sessions={sessions} onModel={onModel} />
      </ChatContext>
    </div>
  );
}
