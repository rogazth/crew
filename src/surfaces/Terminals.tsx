import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useCommands } from '../hooks/useCommand';
import { useSessionActivity } from '../hooks/useSessionActivity';
import { useTerminalPrefs } from '../hooks/useTerminalPrefs';
import { isTerminalTab } from '../lib/tabs';
import { activeTerminal } from '../lib/terminalFocus';
import { zoomed } from '../lib/terminalSettingsView';
import { projectFileAt } from '../lib/terminalPaths';
import { launchCommand, learnMode, watchProviderSession } from '../lib/terminalViewLaunch';
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
  const zoom = (delta: number) => update(zoomed(prefs, delta));

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
    (cwd: string, path: string) => onOpenFile(projectFileAt(cwd, path)),
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

/** Settles which provider session to resume before the first spawn, and learns it after when the CLI names its own. */
function SessionTerminal({ paneId, session, cwd, active, onStatus, onOpenPath }: SessionProps) {
  const [command, setCommand] = useState<string[] | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const { onBell, onActivity, onExit } = useSessionActivity(session, active, onStatus);

  useEffect(() => {
    let cancelled = false;
    launchCommand(session, cwd, DARK_SCHEME.matches ? 'dark' : 'light').then((argv) => {
      if (cancelled) return;
      setStartedAt(Date.now());
      setCommand(argv);
    });
    return () => {
      cancelled = true;
    };
    // The session row changes on rename; the process is already running by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, cwd]);

  const mode = learnMode(session);
  useEffect(() => {
    if (!mode || !startedAt) return;
    return watchProviderSession(mode, session.id, cwd, startedAt);
  }, [mode, startedAt, session.id, cwd]);

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
