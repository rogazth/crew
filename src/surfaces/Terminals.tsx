import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { homeDir } from '../lib/host';
import { useCommands } from '../hooks/useCommand';
import { useSessionActivity } from '../hooks/useSessionActivity';
import { nudgeTitle } from '../hooks/useSessionTitle';
import { useTerminalPrefs } from '../hooks/useTerminalPrefs';
import * as api from '../lib/api';
import { claudeSessionId, transcriptPath } from '../lib/claudeStorage';
import { bindProviderSession } from '../lib/agentRuntime';
import { providerOf } from '../lib/providers';
import { sessionCommand } from '../lib/sessionCommand';
import { titleName } from '../lib/terminalStatus';
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
          find: () => activeTerminal()?.find(),
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
/** codex and opencode write their session only once the first message is sent; Claude moves to a new one on `/clear`. */
const DISCOVER_MS = 3000;
/** Claude stops to ask for a permission with nothing but its screen to say so. */
const ATTENTION_MS = 1500;

async function launchCommand(session: Session, cwd: string): Promise<string[]> {
  const theme = DARK_SCHEME.matches ? 'dark' : 'light';
  const binding = providerOf(session.provider)?.binding;
  if (binding === 'own') {
    // A `/clear` from its last run the daemon never read: resume where the CLI went.
    const moved = await api.rebindClaudeSession(session.id).catch(() => null);
    if (moved) bindProviderSession(session.id, moved);
    const current = moved ? { ...session, providerSessionId: moved } : session;
    const resume = await homeDir()
      .then((home) => api.pathExists(transcriptPath(home, cwd, claudeSessionId(current))))
      .catch(() => false);
    return sessionCommand(current, { resume, theme });
  }
  if (binding === 'before' && !session.providerSessionId) {
    const created = await api.createProviderSession(session.id).catch(() => null);
    if (created) {
      bindProviderSession(session.id, created);
      return sessionCommand({ ...session, providerSessionId: created }, { resume: true, theme });
    }
  }
  return sessionCommand(session, { resume: false, theme });
}

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
  const { onBell, onActivity, onTitle, onInput, onResize, onExit } = useSessionActivity(session, active, onStatus);
  const named = useRef('');
  const retitled = useCallback(
    (title: string) => {
      onTitle(title);
      const name = titleName(title);
      if (name === named.current) return;
      named.current = name;
      nudgeTitle(session.id);
    },
    [onTitle, session.id],
  );

  useEffect(() => {
    let cancelled = false;
    launchCommand(session, cwd).then((argv) => {
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

  const binding = providerOf(session.provider)?.binding;
  const learns = binding === 'own' || (binding === 'after' && !session.providerSessionId);
  useEffect(() => {
    if (!learns || !startedAt) return;
    const learn = () =>
      binding === 'own'
        ? api.rebindClaudeSession(session.id)
        : api.discoverProviderSession(session.id, cwd, startedAt);
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      learn()
        .then((found) => found && bindProviderSession(session.id, found))
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, DISCOVER_MS);
    return () => window.clearInterval(timer);
  }, [learns, binding, startedAt, session.id, cwd]);

  useEffect(() => {
    if (binding !== 'own' || !startedAt) return;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      api
        .claudeAttention(session.id)
        .then((asked) => asked && onBell())
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, ATTENTION_MS);
    return () => window.clearInterval(timer);
  }, [binding, startedAt, session.id, onBell]);

  if (!command) return null;
  return (
    <TerminalView
      id={paneId}
      cwd={cwd}
      command={command}
      session={session.id}
      active={active}
      shellOnExit
      onExit={onExit}
      onBell={onBell}
      onActivity={onActivity}
      onTitle={retitled}
      onInput={onInput}
      onResize={onResize}
      onOpenPath={onOpenPath}
    />
  );
}
