import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { homeDir } from '../lib/host';
import { useCommands } from '../hooks/useCommand';
import { useSessionActivity } from '../hooks/useSessionActivity';
import { useTerminalPrefs } from '../hooks/useTerminalPrefs';
import * as api from '../lib/api';
import { transcriptPath } from '../lib/claudeStorage';
import { sessionCommand } from '../lib/sessionCommand';
import { isTerminalTab, relativeTo } from '../lib/tabs';
import { activeTerminal } from '../lib/terminalFocus';
import { clamp, DEFAULT_TERMINAL_PREFS, LIMITS } from '../lib/terminalPrefs';
import type { MountedPane } from './WorkspacePanes';
import type { ProjectFile, Session, SessionStatus } from '../lib/types';

/** xterm and its addons are ~800 kB of the bundle; the window opens without them. */
const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));

type Props = {
  panes: MountedPane[];
  sessions: Session[];
  onStatus: (id: string, status: SessionStatus) => void;
  onOpenFile: (file: ProjectFile) => void;
};

/**
 * Every open terminal tab stays mounted, shown or not, and of every workspace:
 * unmounting a terminal kills its process, so neither a tab switch nor a
 * workspace switch may end a claude session. Only closing the tab does.
 */
export function Terminals({ panes, sessions, onStatus, onOpenFile }: Props) {
  const focused = panes.find((pane) => pane.visible) ?? null;
  const { prefs, update } = useTerminalPrefs();
  const zoom = (delta: number) =>
    update({
      ...prefs,
      fontSize:
        delta === 0
          ? DEFAULT_TERMINAL_PREFS.fontSize
          : clamp(prefs.fontSize + delta, LIMITS.fontSize),
    });

  // Bound to the terminal filling the active tab, so ⌘F reaches the pane you see.
  useCommands(
    isTerminalTab(focused?.tab ?? null, sessions)
      ? {
          'find-in-terminal': () => activeTerminal()?.find(),
          'zoom-in': () => zoom(1),
          'zoom-out': () => zoom(-1),
          'zoom-reset': () => zoom(0),
        }
      : {},
  );

  const openPath = useCallback(
    (cwd: string, path: string) =>
      onOpenFile({
        name: path.split('/').pop() ?? path,
        path,
        relative: relativeTo(cwd, path),
      }),
    [onOpenFile],
  );

  return panes.map((pane) => {
    const { tab, cwd, visible } = pane;
    if (tab.kind === 'stub' && tab.stub === 'terminal') {
      return (
        <Pane key={pane.id} active={visible}>
          <TerminalView
            id={pane.id}
            cwd={cwd}
            command={[]}
            active={visible}
            onOpenPath={(path) => openPath(cwd, path)}
          />
        </Pane>
      );
    }
    if (tab.kind !== 'session') return null;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session || session.kind !== 'terminal') return null;
    return (
      <Pane key={pane.id} active={visible}>
        <SessionTerminal
          paneId={pane.id}
          session={session}
          cwd={cwd}
          active={visible}
          onStatus={onStatus}
          onOpenPath={(path) => openPath(cwd, path)}
        />
      </Pane>
    );
  });
}

function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div hidden={!active} className="absolute inset-0">
      {/* Per pane, so the first terminal's chunk does not blank the ones already running. */}
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  );
}

const DARK_SCHEME = window.matchMedia('(prefers-color-scheme: dark)');

type SessionProps = {
  paneId: string;
  session: Session;
  cwd: string;
  active: boolean;
  onStatus: (id: string, status: SessionStatus) => void;
  onOpenPath: (path: string) => void;
};

/** Resolves whether the provider already holds a transcript before the first spawn. */
function SessionTerminal({ paneId, session, cwd, active, onStatus, onOpenPath }: SessionProps) {
  const [command, setCommand] = useState<string[] | null>(null);
  const { onBell, onActivity, onExit } = useSessionActivity(session, active, onStatus);

  useEffect(() => {
    let cancelled = false;
    homeDir()
      .then((home) => api.pathExists(transcriptPath(home, cwd, session.id)))
      .catch(() => false)
      .then((resume) => {
        if (cancelled) return;
        const theme = DARK_SCHEME.matches ? 'dark' : 'light';
        setCommand(sessionCommand(session, { resume, theme }));
      });
    return () => {
      cancelled = true;
    };
    // The session row changes on rename; the process is already running by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, cwd]);

  if (!command) return null;
  return (
    <TerminalView
      id={paneId}
      cwd={cwd}
      command={command}
      active={active}
      shellOnExit
      onExit={onExit}
      onBell={onBell}
      onActivity={onActivity}
      onOpenPath={onOpenPath}
    />
  );
}
